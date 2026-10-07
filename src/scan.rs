use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use walkdir::{DirEntry, WalkDir};

use crate::skipped::{SkipReason, SkippedPath};

/// Какой физический файл лежит по пути: устройство и номер файла на нём. Жёсткие ссылки
/// и одна папка, видимая по двум путям, дают одну и ту же идентичность.
// На системах без устройства и номера файла идентичность не строится, и поля остаются без дела.
#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FileIdentity {
    device: u64,
    inode: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScannedFile {
    pub path: PathBuf,
    pub size: u64,
    pub modified: SystemTime,
    /// `None` там, где ОС не даёт устройство и номер файла: тогда ссылки на один файл не отличить.
    pub identity: Option<FileIdentity>,
}

impl ScannedFile {
    pub fn from_metadata(path: PathBuf, metadata: &fs::Metadata) -> io::Result<Self> {
        Ok(ScannedFile {
            path,
            size: metadata.len(),
            modified: metadata.modified()?,
            identity: identity_of(metadata),
        })
    }
}

#[cfg(unix)]
fn identity_of(metadata: &fs::Metadata) -> Option<FileIdentity> {
    use std::os::unix::fs::MetadataExt;

    Some(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(unix))]
fn identity_of(_metadata: &fs::Metadata) -> Option<FileIdentity> {
    None
}

/// Что стало с файлом с момента проверки папки.
#[derive(Debug)]
pub enum FileCheck {
    Unchanged,
    Changed,
    Vanished,
    Failed(io::Error),
}

#[derive(Debug)]
pub struct FolderScan {
    pub files: Vec<ScannedFile>,
    pub skipped: Vec<SkippedPath>,
}

/// Причина, по которой саму указанную папку проверить нельзя.
#[derive(Debug)]
pub enum FolderError {
    NotFound(PathBuf),
    NotAFolder(PathBuf),
    PathThroughFile(PathBuf),
    AccessDenied(PathBuf),
    Unreadable(PathBuf, io::Error),
}

impl fmt::Display for FolderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FolderError::NotFound(folder) => write!(
                formatter,
                "Папка «{}» не найдена. Проверьте, правильно ли написан путь.",
                folder.display()
            ),
            FolderError::NotAFolder(path) => write!(
                formatter,
                "«{}» — это файл, а не папка. Укажите папку, в которой искать одинаковые файлы.",
                path.display()
            ),
            FolderError::PathThroughFile(path) => write!(
                formatter,
                "Не удалось открыть «{}»: одна из частей этого пути — файл, а не папка. \
                 Проверьте, правильно ли написан путь.",
                path.display()
            ),
            FolderError::AccessDenied(folder) => write!(
                formatter,
                "Нет доступа к папке «{}»: не хватает прав на чтение.",
                folder.display()
            ),
            FolderError::Unreadable(folder, error) => write!(
                formatter,
                "Не удалось открыть папку «{}» из-за непредвиденной ошибки (системное сообщение: {error}).",
                folder.display()
            ),
        }
    }
}

enum Visited {
    File(ScannedFile),
    Skipped(SkippedPath),
    Ignored,
}

/// Находит файлы папки. Папки, для которых `is_excluded` отвечает «да», не обходятся вовсе —
/// в том числе сама указанная папка и любая из её родительских. Каждый физический файл
/// попадает в результат один раз — по первому пути в порядке обхода.
pub fn scan_folder(
    folder: &Path,
    is_excluded: &impl Fn(&Path) -> bool,
) -> Result<FolderScan, FolderError> {
    let metadata = fs::metadata(folder).map_err(|error| folder_error(folder, error))?;
    if !metadata.is_dir() {
        return Err(FolderError::NotAFolder(folder.to_path_buf()));
    }

    // Права на саму папку проверяем заранее: обход молча пропустил бы её содержимое.
    fs::read_dir(folder).map_err(|error| folder_error(folder, error))?;

    if is_inside_excluded_folder(folder, is_excluded) {
        return Ok(FolderScan {
            files: Vec::new(),
            skipped: Vec::new(),
        });
    }

    // Симлинки внутри папки не раскрываем, а симлинк, указанный как сама папка, — раскрываем.
    let walker = WalkDir::new(folder)
        .follow_links(false)
        .follow_root_links(true)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| !is_excluded_subfolder(entry, is_excluded));
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut seen_identities = HashSet::new();
    for entry in walker {
        match visit(entry) {
            Visited::File(file) if is_first_sight(&file, &mut seen_identities) => files.push(file),
            Visited::File(_another_path_to_seen_file) => {}
            Visited::Skipped(skipped_path) => skipped.push(skipped_path),
            Visited::Ignored => {}
        }
    }

    Ok(FolderScan { files, skipped })
}

/// Указанная папка может лежать внутри исключённой (например, `Trash/files`), поэтому
/// проверяются и все её родительские папки.
fn is_inside_excluded_folder(folder: &Path, is_excluded: &impl Fn(&Path) -> bool) -> bool {
    let location = fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
    location.ancestors().any(is_excluded)
}

fn is_excluded_subfolder(entry: &DirEntry, is_excluded: &impl Fn(&Path) -> bool) -> bool {
    let is_subfolder = entry.depth() > 0 && entry.file_type().is_dir();
    is_subfolder && is_excluded(entry.path())
}

fn is_first_sight(file: &ScannedFile, seen_identities: &mut HashSet<FileIdentity>) -> bool {
    match file.identity {
        Some(identity) => seen_identities.insert(identity),
        None => true,
    }
}

fn folder_error(folder: &Path, error: io::Error) -> FolderError {
    let folder = folder.to_path_buf();
    match error.kind() {
        io::ErrorKind::NotFound => FolderError::NotFound(folder),
        io::ErrorKind::NotADirectory => FolderError::PathThroughFile(folder),
        io::ErrorKind::PermissionDenied => FolderError::AccessDenied(folder),
        _ => FolderError::Unreadable(folder, error),
    }
}

fn visit(entry: Result<DirEntry, walkdir::Error>) -> Visited {
    let entry = match entry {
        Ok(entry) => entry,
        Err(error) => return Visited::Skipped(skipped_by_walk_error(&error)),
    };

    // Симлинки не открываем: они указывали бы на файл второй раз.
    if !entry.file_type().is_file() {
        return Visited::Ignored;
    }

    let metadata = match entry.metadata() {
        Ok(metadata) => metadata,
        Err(error) => return Visited::Skipped(skipped_by_walk_error(&error)),
    };

    let path = entry.into_path();
    match ScannedFile::from_metadata(path.clone(), &metadata) {
        Ok(file) => Visited::File(file),
        Err(error) => Visited::Skipped(SkippedPath {
            path,
            reason: SkipReason::from(&error),
        }),
    }
}

/// Сравнивает файл с тем, каким его увидела проверка папки: размер, время изменения и идентичность
/// (по тому же пути мог оказаться уже другой файл). Содержимое заново не читается, поэтому правка
/// на месте, не менявшая ни размер, ни время, незаметна.
pub fn check_unchanged(file: &ScannedFile) -> FileCheck {
    let metadata = match fs::symlink_metadata(&file.path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return FileCheck::Vanished,
        Err(error) => return FileCheck::Failed(error),
    };

    // Обычный файл мог стать ссылкой или папкой: переносить в корзину такое нельзя вслепую.
    if !metadata.is_file() {
        return FileCheck::Changed;
    }

    let modified = match metadata.modified() {
        Ok(modified) => modified,
        Err(error) => return FileCheck::Failed(error),
    };

    let is_same_file = metadata.len() == file.size
        && modified == file.modified
        && identity_of(&metadata) == file.identity;
    if is_same_file {
        FileCheck::Unchanged
    } else {
        FileCheck::Changed
    }
}

fn skipped_by_walk_error(error: &walkdir::Error) -> SkippedPath {
    let path = error.path().map(Path::to_path_buf).unwrap_or_default();
    let reason = match error.io_error() {
        Some(io_error) => SkipReason::from(io_error),
        None => SkipReason::Unreadable(error.to_string()),
    };

    SkippedPath { path, reason }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::time::Duration;
    use tempfile::TempDir;

    const ONE_HOUR: Duration = Duration::from_secs(3600);

    fn scan_all(folder: &Path) -> Result<FolderScan, FolderError> {
        scan_folder(folder, &|_| false)
    }

    fn is_named_skipped(folder: &Path) -> bool {
        folder.file_name().is_some_and(|name| name == "skipped")
    }

    fn file_names(scan: &FolderScan) -> Vec<String> {
        scan.files
            .iter()
            .map(|file| {
                file.path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    }

    #[test]
    fn finds_nested_files_with_sizes() {
        let folder = TempDir::new().unwrap();
        fs::write(folder.path().join("a.txt"), "abc").unwrap();
        fs::create_dir(folder.path().join("inner")).unwrap();
        fs::write(folder.path().join("inner").join("b.txt"), "hello").unwrap();

        let scan = scan_all(folder.path()).unwrap();

        assert_eq!(file_names(&scan), ["a.txt", "b.txt"]);
        assert_eq!(scan.files[0].size, 3);
        assert_eq!(scan.files[1].size, 5);
        assert!(scan.skipped.is_empty());
    }

    #[test]
    fn scanned_file_remembers_modification_time() {
        let folder = TempDir::new().unwrap();
        let path = folder.path().join("a.txt");
        fs::write(&path, "abc").unwrap();
        let modified = SystemTime::UNIX_EPOCH + ONE_HOUR;
        set_modified(&path, modified);

        let scan = scan_all(folder.path()).unwrap();

        assert_eq!(scan.files[0].modified, modified);
    }

    fn set_modified(path: &Path, modified: SystemTime) {
        let file = File::options().write(true).open(path).unwrap();
        file.set_modified(modified).unwrap();
    }

    fn scan_single_file(folder: &TempDir, content: &str) -> ScannedFile {
        let path = folder.path().join("a.txt");
        fs::write(&path, content).unwrap();
        let mut scan = scan_all(folder.path()).unwrap();
        scan.files.remove(0)
    }

    #[test]
    fn untouched_file_is_unchanged() {
        let folder = TempDir::new().unwrap();
        let file = scan_single_file(&folder, "abc");

        assert!(matches!(check_unchanged(&file), FileCheck::Unchanged));
    }

    #[test]
    fn file_with_other_size_is_changed() {
        let folder = TempDir::new().unwrap();
        let file = scan_single_file(&folder, "abc");
        fs::write(&file.path, "abcdef").unwrap();
        set_modified(&file.path, file.modified);

        assert!(matches!(check_unchanged(&file), FileCheck::Changed));
    }

    #[test]
    fn file_with_only_other_modification_time_is_changed() {
        let folder = TempDir::new().unwrap();
        let file = scan_single_file(&folder, "abc");
        set_modified(&file.path, file.modified + ONE_HOUR);

        assert!(matches!(check_unchanged(&file), FileCheck::Changed));
    }

    #[test]
    fn removed_file_is_vanished() {
        let folder = TempDir::new().unwrap();
        let file = scan_single_file(&folder, "abc");
        fs::remove_file(&file.path).unwrap();

        assert!(matches!(check_unchanged(&file), FileCheck::Vanished));
    }

    #[test]
    fn file_replaced_by_folder_is_changed() {
        let folder = TempDir::new().unwrap();
        let file = scan_single_file(&folder, "abc");
        fs::remove_file(&file.path).unwrap();
        fs::create_dir(&file.path).unwrap();

        assert!(matches!(check_unchanged(&file), FileCheck::Changed));
    }

    #[test]
    fn path_through_a_file_is_a_failed_check() {
        let folder = TempDir::new().unwrap();
        let file = scan_single_file(&folder, "abc");
        let behind_file = ScannedFile {
            path: file.path.join("inner"),
            ..file
        };

        assert!(matches!(
            check_unchanged(&behind_file),
            FileCheck::Failed(_)
        ));
    }

    #[test]
    fn excluded_folder_is_not_entered() {
        let folder = TempDir::new().unwrap();
        fs::write(folder.path().join("a.txt"), "abc").unwrap();
        let excluded = folder.path().join("inner").join("skipped");
        fs::create_dir_all(&excluded).unwrap();
        fs::write(excluded.join("b.txt"), "abc").unwrap();
        fs::write(folder.path().join("inner").join("c.txt"), "abc").unwrap();

        let scan = scan_folder(folder.path(), &is_named_skipped).unwrap();

        assert_eq!(file_names(&scan), ["a.txt", "c.txt"]);
        assert!(scan.skipped.is_empty());
    }

    #[test]
    fn excluded_file_name_is_not_a_reason_to_skip_a_file() {
        let folder = TempDir::new().unwrap();
        fs::write(folder.path().join("skipped"), "abc").unwrap();

        let scan = scan_folder(folder.path(), &is_named_skipped).unwrap();

        assert_eq!(file_names(&scan), ["skipped"]);
    }

    #[test]
    fn excluded_folder_given_as_root_finds_nothing() {
        let folder = TempDir::new().unwrap();
        let excluded = folder.path().join("skipped");
        fs::create_dir(&excluded).unwrap();
        fs::write(excluded.join("a.txt"), "abc").unwrap();

        let scan = scan_folder(&excluded, &is_named_skipped).unwrap();

        assert!(scan.files.is_empty());
        assert!(scan.skipped.is_empty());
    }

    #[test]
    fn folder_inside_excluded_folder_given_as_root_finds_nothing() {
        let folder = TempDir::new().unwrap();
        let inside_excluded = folder.path().join("skipped").join("files");
        fs::create_dir_all(&inside_excluded).unwrap();
        fs::write(inside_excluded.join("a.txt"), "abc").unwrap();

        let scan = scan_folder(&inside_excluded, &is_named_skipped).unwrap();

        assert!(scan.files.is_empty());
    }

    #[test]
    fn missing_folder_is_reported_even_if_exclusion_matches_everything() {
        let folder = TempDir::new().unwrap();

        let result = scan_folder(&folder.path().join("missing"), &|_| true);

        assert!(matches!(result, Err(FolderError::NotFound(_))));
    }

    #[cfg(unix)]
    #[test]
    fn hard_links_to_one_file_are_scanned_once() {
        let folder = TempDir::new().unwrap();
        let first = folder.path().join("a.txt");
        fs::write(&first, "abc").unwrap();
        fs::hard_link(&first, folder.path().join("b.txt")).unwrap();
        fs::write(folder.path().join("c.txt"), "abc").unwrap();

        let scan = scan_all(folder.path()).unwrap();

        assert_eq!(file_names(&scan), ["a.txt", "c.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn file_replaced_by_another_with_same_size_and_time_is_changed() {
        let folder = TempDir::new().unwrap();
        let file = scan_single_file(&folder, "abc");
        let replacement = folder.path().join("replacement.txt");
        fs::write(&replacement, "xyz").unwrap();
        set_modified(&replacement, file.modified);
        fs::rename(&replacement, &file.path).unwrap();

        assert!(matches!(check_unchanged(&file), FileCheck::Changed));
    }

    #[cfg(unix)]
    #[test]
    fn ignores_symlinks() {
        let folder = TempDir::new().unwrap();
        let target = folder.path().join("real.txt");
        fs::write(&target, "abc").unwrap();
        std::os::unix::fs::symlink(&target, folder.path().join("link.txt")).unwrap();

        let scan = scan_all(folder.path()).unwrap();

        assert_eq!(file_names(&scan), ["real.txt"]);
        assert!(scan.skipped.is_empty());
    }

    #[test]
    fn missing_folder_is_not_found() {
        let folder = TempDir::new().unwrap();

        let result = scan_all(&folder.path().join("missing"));

        assert!(matches!(result, Err(FolderError::NotFound(_))));
    }

    #[test]
    fn file_instead_of_folder_is_rejected() {
        let folder = TempDir::new().unwrap();
        let file = folder.path().join("a.txt");
        fs::write(&file, "abc").unwrap();

        let result = scan_all(&file);

        assert!(matches!(result, Err(FolderError::NotAFolder(_))));
    }

    #[test]
    fn path_through_a_file_is_explained() {
        let folder = TempDir::new().unwrap();
        let file = folder.path().join("a.txt");
        fs::write(&file, "abc").unwrap();

        let result = scan_all(&file.join("sub"));

        let error = result.unwrap_err();
        assert!(matches!(error, FolderError::PathThroughFile(_)));
        let message = error.to_string();
        assert!(message.contains("одна из частей этого пути — файл, а не папка"));
        assert!(!message.contains("os error"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_folder_given_as_root_is_followed() {
        let folder = TempDir::new().unwrap();
        let real_folder = folder.path().join("real");
        fs::create_dir(&real_folder).unwrap();
        fs::write(real_folder.join("a.txt"), "abc").unwrap();
        fs::write(real_folder.join("b.txt"), "abc").unwrap();
        let link = folder.path().join("link");
        std::os::unix::fs::symlink(&real_folder, &link).unwrap();

        let scan = scan_all(&link).unwrap();

        let search = crate::duplicates::find_duplicates(scan.files);
        assert_eq!(search.groups.len(), 1);
        assert_eq!(search.groups[0].kept.path, link.join("a.txt"));
        assert_eq!(search.groups[0].copies[0].path, link.join("b.txt"));
    }

    #[test]
    fn permission_denied_becomes_access_denied() {
        let error = io::Error::from(io::ErrorKind::PermissionDenied);

        let result = folder_error(Path::new("/x"), error);

        assert!(matches!(result, FolderError::AccessDenied(_)));
    }

    #[test]
    fn other_error_becomes_unreadable() {
        let error = io::Error::from(io::ErrorKind::Other);

        let result = folder_error(Path::new("/x"), error);

        assert!(matches!(result, FolderError::Unreadable(_, _)));
    }

    #[test]
    fn unreadable_folder_message_explains_before_system_text() {
        let error = FolderError::Unreadable(PathBuf::from("/x"), io::Error::other("disk failure"));

        assert_eq!(
            error.to_string(),
            "Не удалось открыть папку «/x» из-за непредвиденной ошибки (системное сообщение: disk failure)."
        );
    }
}
