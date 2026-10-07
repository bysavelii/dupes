use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io;
use std::path::Path;

use crate::cleanup::CleanupGroup;
use crate::scan::ScannedFile;
use crate::skipped::SkippedPath;

/// Файлы с одинаковым содержимым: `kept` остаётся, `copies` — лишние, по пути.
/// В группе всегда есть хотя бы одна копия.
#[derive(Debug)]
pub struct DuplicateGroup {
    pub kept: ScannedFile,
    pub copies: Vec<ScannedFile>,
}

impl DuplicateGroup {
    /// Размер каждого файла группы: содержимое у всех одинаковое.
    pub fn size(&self) -> u64 {
        self.kept.size
    }

    /// Сколько места освободится, если оставить в группе один файл.
    pub fn reclaimable_bytes(&self) -> u64 {
        self.copies.iter().map(|copy| copy.size).sum()
    }
}

impl CleanupGroup for DuplicateGroup {
    fn kept_file(&self) -> &ScannedFile {
        &self.kept
    }

    fn extra_files(&self) -> Vec<&ScannedFile> {
        self.copies.iter().collect()
    }
}

#[derive(Debug)]
pub struct DuplicateSearch {
    pub groups: Vec<DuplicateGroup>,
    pub skipped: Vec<SkippedPath>,
}

impl DuplicateSearch {
    pub fn reclaimable_bytes(&self) -> u64 {
        self.groups
            .iter()
            .map(DuplicateGroup::reclaimable_bytes)
            .sum()
    }
}

struct HashedSizeGroup {
    groups: Vec<DuplicateGroup>,
    skipped: Vec<SkippedPath>,
}

pub fn find_duplicates(files: Vec<ScannedFile>) -> DuplicateSearch {
    let mut unsorted_groups = Vec::new();
    let mut skipped = Vec::new();

    for same_size_files in group_by_size(files).into_values() {
        let hashed = group_by_content(same_size_files);
        unsorted_groups.extend(hashed.groups);
        skipped.extend(hashed.skipped);
    }

    let groups = sorted_groups(unsorted_groups);

    DuplicateSearch { groups, skipped }
}

/// Оставляет только размеры, у которых есть хотя бы два файла: остальные не могут быть дубликатами.
/// Пустые файлы не считаются: у них нечего освобождать.
fn group_by_size(files: Vec<ScannedFile>) -> BTreeMap<u64, Vec<ScannedFile>> {
    let mut files_by_size: BTreeMap<u64, Vec<ScannedFile>> = BTreeMap::new();
    for file in files {
        files_by_size.entry(file.size).or_default().push(file);
    }

    files_by_size.remove(&0);
    files_by_size.retain(|_, same_size_files| same_size_files.len() >= 2);
    files_by_size
}

fn group_by_content(files: Vec<ScannedFile>) -> HashedSizeGroup {
    let mut files_by_hash: HashMap<blake3::Hash, Vec<ScannedFile>> = HashMap::new();
    let mut skipped = Vec::new();

    for file in files {
        match hash_content(&file.path) {
            Ok(hash) => files_by_hash.entry(hash).or_default().push(file),
            Err(error) => skipped.push(SkippedPath {
                reason: (&error).into(),
                path: file.path,
            }),
        }
    }

    let groups = files_by_hash
        .into_values()
        .filter(|same_content_files| same_content_files.len() >= 2)
        .map(split_kept_file)
        .collect();

    HashedSizeGroup { groups, skipped }
}

/// Читает файл потоком, чтобы большие файлы не занимали память целиком.
fn hash_content(path: &Path) -> io::Result<blake3::Hash> {
    let file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    hasher.update_reader(file)?;
    Ok(hasher.finalize())
}

/// Оставляем самый старый файл: он, скорее всего, оригинал, а копии новее. Время создания
/// не берём: его есть не везде, и при копировании оно сбрасывается.
fn split_kept_file(files: Vec<ScannedFile>) -> DuplicateGroup {
    let mut copies = files;
    copies.sort_by(keep_priority);
    let kept = copies.remove(0);
    copies.sort_by(|first, second| first.path.cmp(&second.path));

    DuplicateGroup { kept, copies }
}

/// Первым идёт файл, который стоит оставить: сначала самый ранний по времени изменения,
/// при равенстве — с более коротким путём, затем первый по алфавиту.
fn keep_priority(first: &ScannedFile, second: &ScannedFile) -> Ordering {
    first
        .modified
        .cmp(&second.modified)
        .then_with(|| {
            first
                .path
                .as_os_str()
                .len()
                .cmp(&second.path.as_os_str().len())
        })
        .then_with(|| first.path.cmp(&second.path))
}

/// Порядок должен быть одинаковым при каждом запуске, поэтому при равенстве сравниваем пути.
fn sorted_groups(groups: Vec<DuplicateGroup>) -> Vec<DuplicateGroup> {
    let mut sorted = groups;
    sorted.sort_by(|first, second| {
        second
            .reclaimable_bytes()
            .cmp(&first.reclaimable_bytes())
            .then_with(|| first.kept.path.cmp(&second.kept.path))
    });
    sorted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skipped::SkipReason;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime};
    use tempfile::TempDir;

    fn modified_after_epoch(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn scanned(path: &str, size: u64) -> ScannedFile {
        scanned_at(path, size, 0)
    }

    fn scanned_at(path: &str, size: u64, modified_seconds: u64) -> ScannedFile {
        ScannedFile {
            path: PathBuf::from(path),
            size,
            modified: modified_after_epoch(modified_seconds),
            identity: None,
        }
    }

    fn write_file(folder: &TempDir, name: &str, content: &str) -> ScannedFile {
        write_file_modified(folder, name, content, 0)
    }

    fn write_file_modified(
        folder: &TempDir,
        name: &str,
        content: &str,
        modified_seconds: u64,
    ) -> ScannedFile {
        let path = folder.path().join(name);
        fs::write(&path, content).unwrap();
        ScannedFile {
            size: content.len() as u64,
            modified: modified_after_epoch(modified_seconds),
            identity: None,
            path,
        }
    }

    fn paths(files: &[ScannedFile]) -> Vec<&Path> {
        files.iter().map(|file| file.path.as_path()).collect()
    }

    #[test]
    fn group_by_size_drops_single_sizes() {
        let files = vec![scanned("a", 10), scanned("b", 10), scanned("c", 20)];

        let groups = group_by_size(files);

        assert_eq!(groups.len(), 1);
        assert_eq!(paths(&groups[&10]), [Path::new("a"), Path::new("b")]);
    }

    #[test]
    fn group_by_size_drops_empty_files() {
        let files = vec![scanned("a", 0), scanned("b", 0)];

        let groups = group_by_size(files);

        assert!(groups.is_empty());
    }

    #[test]
    fn oldest_file_is_kept() {
        let group = split_kept_file(vec![
            scanned_at("a", 5, 300),
            scanned_at("b", 5, 100),
            scanned_at("c", 5, 200),
        ]);

        assert_eq!(group.kept.path, PathBuf::from("b"));
    }

    #[test]
    fn equal_age_is_decided_by_shorter_path() {
        let group = split_kept_file(vec![
            scanned_at("folder/a.txt", 5, 100),
            scanned_at("z.txt", 5, 100),
            scanned_at("folder/sub/a.txt", 5, 100),
        ]);

        assert_eq!(group.kept.path, PathBuf::from("z.txt"));
    }

    #[test]
    fn path_length_is_counted_in_bytes() {
        let group = split_kept_file(vec![scanned_at("яя", 5, 100), scanned_at("zzz", 5, 100)]);

        assert_eq!(group.kept.path, PathBuf::from("zzz"));
    }

    #[test]
    fn equal_age_and_length_are_decided_by_alphabet() {
        let group = split_kept_file(vec![
            scanned_at("c.txt", 5, 100),
            scanned_at("a.txt", 5, 100),
            scanned_at("b.txt", 5, 100),
        ]);

        assert_eq!(group.kept.path, PathBuf::from("a.txt"));
    }

    #[test]
    fn older_file_wins_over_shorter_path() {
        let group = split_kept_file(vec![
            scanned_at("a", 5, 200),
            scanned_at("long/path/name.txt", 5, 100),
        ]);

        assert_eq!(group.kept.path, PathBuf::from("long/path/name.txt"));
    }

    #[test]
    fn copies_are_sorted_by_path() {
        let group = split_kept_file(vec![
            scanned_at("z", 5, 300),
            scanned_at("kept", 5, 100),
            scanned_at("m", 5, 500),
            scanned_at("b", 5, 200),
        ]);

        assert_eq!(
            paths(&group.copies),
            [Path::new("b"), Path::new("m"), Path::new("z")]
        );
    }

    #[test]
    fn group_reclaims_all_copies_but_the_kept_one() {
        let group = DuplicateGroup {
            kept: scanned("a", 100),
            copies: vec![scanned("b", 100), scanned("c", 100)],
        };

        assert_eq!(group.size(), 100);
        assert_eq!(group.reclaimable_bytes(), 200);
    }

    #[test]
    fn search_sums_reclaimable_bytes_of_groups() {
        let search = DuplicateSearch {
            groups: vec![
                DuplicateGroup {
                    kept: scanned("a", 100),
                    copies: vec![scanned("b", 100)],
                },
                DuplicateGroup {
                    kept: scanned("c", 10),
                    copies: vec![scanned("d", 10), scanned("e", 10)],
                },
            ],
            skipped: Vec::new(),
        };

        assert_eq!(search.reclaimable_bytes(), 120);
    }

    #[test]
    fn identical_files_form_one_group() {
        let folder = TempDir::new().unwrap();
        let files = vec![
            write_file_modified(&folder, "b.txt", "same", 200),
            write_file_modified(&folder, "a.txt", "same", 100),
        ];

        let search = find_duplicates(files);

        assert_eq!(search.groups.len(), 1);
        assert_eq!(search.groups[0].size(), 4);
        assert_eq!(search.groups[0].kept.path, folder.path().join("a.txt"));
        assert_eq!(
            paths(&search.groups[0].copies),
            [folder.path().join("b.txt")]
        );
        assert!(search.skipped.is_empty());
    }

    #[test]
    fn same_size_with_different_content_is_not_a_group() {
        let folder = TempDir::new().unwrap();
        let files = vec![
            write_file(&folder, "a.txt", "aaaa"),
            write_file(&folder, "b.txt", "bbbb"),
        ];

        let search = find_duplicates(files);

        assert!(search.groups.is_empty());
    }

    #[test]
    fn groups_are_sorted_by_reclaimable_bytes_then_kept_path() {
        let folder = TempDir::new().unwrap();
        let files = vec![
            write_file(&folder, "small_b.txt", "ab"),
            write_file(&folder, "big_z.txt", "0123456789"),
            write_file(&folder, "small_a.txt", "ab"),
            write_file(&folder, "big_y.txt", "0123456789"),
            write_file(&folder, "tie_b.txt", "xy"),
            write_file(&folder, "tie_a.txt", "xy"),
            write_file(&folder, "other_b.txt", "pq"),
            write_file(&folder, "other_a.txt", "pq"),
        ];

        let search = find_duplicates(files);

        let kept_paths: Vec<&PathBuf> =
            search.groups.iter().map(|group| &group.kept.path).collect();
        assert_eq!(
            kept_paths,
            [
                &folder.path().join("big_y.txt"),
                &folder.path().join("other_a.txt"),
                &folder.path().join("small_a.txt"),
                &folder.path().join("tie_a.txt"),
            ]
        );
        assert_eq!(
            paths(&search.groups[0].copies),
            [folder.path().join("big_z.txt")]
        );
    }

    #[test]
    fn file_removed_before_hashing_is_skipped_as_vanished() {
        let folder = TempDir::new().unwrap();
        let present = write_file(&folder, "present.txt", "data");
        let vanished = write_file(&folder, "vanished.txt", "data");
        fs::remove_file(&vanished.path).unwrap();
        let vanished_path = vanished.path.clone();

        let search = find_duplicates(vec![present, vanished]);

        assert!(search.groups.is_empty());
        assert_eq!(search.skipped.len(), 1);
        assert_eq!(search.skipped[0].path, vanished_path);
        assert_eq!(search.skipped[0].reason, SkipReason::Vanished);
    }
}
