use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use walkdir::{DirEntry, WalkDir};

use crate::skipped::{SkipReason, SkippedPath};

#[derive(Debug)]
pub struct ScannedFile {
    pub path: PathBuf,
    pub size: u64,
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

pub fn scan_folder(folder: &Path) -> Result<FolderScan, FolderError> {
    let metadata = fs::metadata(folder).map_err(|error| folder_error(folder, error))?;
    if !metadata.is_dir() {
        return Err(FolderError::NotAFolder(folder.to_path_buf()));
    }

    // Права на саму папку проверяем заранее: обход молча пропустил бы её содержимое.
    fs::read_dir(folder).map_err(|error| folder_error(folder, error))?;

    // Симлинки внутри папки не раскрываем, а симлинк, указанный как сама папка, — раскрываем.
    let walker = WalkDir::new(folder)
        .follow_links(false)
        .follow_root_links(true)
        .sort_by_file_name();
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    for entry in walker {
        match visit(entry) {
            Visited::File(file) => files.push(file),
            Visited::Skipped(skipped_path) => skipped.push(skipped_path),
            Visited::Ignored => {}
        }
    }

    Ok(FolderScan { files, skipped })
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

    match entry.metadata() {
        Ok(metadata) => Visited::File(ScannedFile {
            path: entry.into_path(),
            size: metadata.len(),
        }),
        Err(error) => Visited::Skipped(skipped_by_walk_error(&error)),
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
    use tempfile::TempDir;

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

        let scan = scan_folder(folder.path()).unwrap();

        assert_eq!(file_names(&scan), ["a.txt", "b.txt"]);
        assert_eq!(scan.files[0].size, 3);
        assert_eq!(scan.files[1].size, 5);
        assert!(scan.skipped.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn ignores_symlinks() {
        let folder = TempDir::new().unwrap();
        let target = folder.path().join("real.txt");
        fs::write(&target, "abc").unwrap();
        std::os::unix::fs::symlink(&target, folder.path().join("link.txt")).unwrap();

        let scan = scan_folder(folder.path()).unwrap();

        assert_eq!(file_names(&scan), ["real.txt"]);
        assert!(scan.skipped.is_empty());
    }

    #[test]
    fn missing_folder_is_not_found() {
        let folder = TempDir::new().unwrap();

        let result = scan_folder(&folder.path().join("missing"));

        assert!(matches!(result, Err(FolderError::NotFound(_))));
    }

    #[test]
    fn file_instead_of_folder_is_rejected() {
        let folder = TempDir::new().unwrap();
        let file = folder.path().join("a.txt");
        fs::write(&file, "abc").unwrap();

        let result = scan_folder(&file);

        assert!(matches!(result, Err(FolderError::NotAFolder(_))));
    }

    #[test]
    fn path_through_a_file_is_explained() {
        let folder = TempDir::new().unwrap();
        let file = folder.path().join("a.txt");
        fs::write(&file, "abc").unwrap();

        let result = scan_folder(&file.join("sub"));

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

        let scan = scan_folder(&link).unwrap();

        let search = crate::duplicates::find_duplicates(scan.files);
        assert_eq!(search.groups.len(), 1);
        assert_eq!(
            search.groups[0].paths,
            [link.join("a.txt"), link.join("b.txt")]
        );
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
