use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use crate::scan::ScannedFile;
use crate::skipped::SkippedPath;

/// Файлы с одинаковым содержимым; в группе всегда не меньше двух путей.
#[derive(Debug)]
pub struct DuplicateGroup {
    pub size: u64,
    pub paths: Vec<PathBuf>,
}

impl DuplicateGroup {
    /// Сколько места освободится, если оставить в группе один файл.
    pub fn reclaimable_bytes(&self) -> u64 {
        let extra_copies = self.paths.len().saturating_sub(1) as u64;
        self.size * extra_copies
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

    for (size, paths) in group_by_size(files) {
        let hashed = group_by_content(size, paths);
        unsorted_groups.extend(hashed.groups);
        skipped.extend(hashed.skipped);
    }

    let groups = sorted_groups(unsorted_groups);

    DuplicateSearch { groups, skipped }
}

/// Оставляет только размеры, у которых есть хотя бы два файла: остальные не могут быть дубликатами.
/// Пустые файлы не считаются: у них нечего освобождать.
fn group_by_size(files: Vec<ScannedFile>) -> BTreeMap<u64, Vec<PathBuf>> {
    let mut paths_by_size: BTreeMap<u64, Vec<PathBuf>> = BTreeMap::new();
    for file in files {
        paths_by_size.entry(file.size).or_default().push(file.path);
    }

    paths_by_size.remove(&0);
    paths_by_size.retain(|_, paths| paths.len() >= 2);
    paths_by_size
}

fn group_by_content(size: u64, paths: Vec<PathBuf>) -> HashedSizeGroup {
    let mut paths_by_hash: HashMap<blake3::Hash, Vec<PathBuf>> = HashMap::new();
    let mut skipped = Vec::new();

    for path in paths {
        match hash_content(&path) {
            Ok(hash) => paths_by_hash.entry(hash).or_default().push(path),
            Err(error) => skipped.push(SkippedPath {
                reason: (&error).into(),
                path,
            }),
        }
    }

    let groups = paths_by_hash
        .into_values()
        .filter(|paths| paths.len() >= 2)
        .map(|paths| DuplicateGroup { size, paths })
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

/// Порядок должен быть одинаковым при каждом запуске, поэтому при равенстве сравниваем пути.
fn sorted_groups(groups: Vec<DuplicateGroup>) -> Vec<DuplicateGroup> {
    let mut sorted: Vec<DuplicateGroup> = groups
        .into_iter()
        .map(|group| DuplicateGroup {
            size: group.size,
            paths: sorted_paths(group.paths),
        })
        .collect();

    sorted.sort_by(|first, second| {
        second
            .reclaimable_bytes()
            .cmp(&first.reclaimable_bytes())
            .then_with(|| first.paths.cmp(&second.paths))
    });
    sorted
}

fn sorted_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut sorted = paths;
    sorted.sort();
    sorted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skipped::SkipReason;
    use std::fs;
    use tempfile::TempDir;

    fn scanned(path: &str, size: u64) -> ScannedFile {
        ScannedFile {
            path: PathBuf::from(path),
            size,
        }
    }

    fn write_file(folder: &TempDir, name: &str, content: &str) -> ScannedFile {
        let path = folder.path().join(name);
        fs::write(&path, content).unwrap();
        ScannedFile {
            size: content.len() as u64,
            path,
        }
    }

    #[test]
    fn group_by_size_drops_single_sizes() {
        let files = vec![scanned("a", 10), scanned("b", 10), scanned("c", 20)];

        let groups = group_by_size(files);

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[&10], [PathBuf::from("a"), PathBuf::from("b")]);
    }

    #[test]
    fn group_by_size_drops_empty_files() {
        let files = vec![scanned("a", 0), scanned("b", 0)];

        let groups = group_by_size(files);

        assert!(groups.is_empty());
    }

    #[test]
    fn group_reclaims_all_copies_but_one() {
        let group = DuplicateGroup {
            size: 100,
            paths: vec!["a".into(), "b".into(), "c".into()],
        };

        assert_eq!(group.reclaimable_bytes(), 200);
    }

    #[test]
    fn search_sums_reclaimable_bytes_of_groups() {
        let search = DuplicateSearch {
            groups: vec![
                DuplicateGroup {
                    size: 100,
                    paths: vec!["a".into(), "b".into()],
                },
                DuplicateGroup {
                    size: 10,
                    paths: vec!["c".into(), "d".into(), "e".into()],
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
            write_file(&folder, "a.txt", "same"),
            write_file(&folder, "b.txt", "same"),
        ];

        let search = find_duplicates(files);

        assert_eq!(search.groups.len(), 1);
        assert_eq!(search.groups[0].size, 4);
        assert_eq!(
            search.groups[0].paths,
            [folder.path().join("a.txt"), folder.path().join("b.txt")]
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
    fn groups_are_sorted_by_reclaimable_bytes_then_paths() {
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

        let first_paths: Vec<&PathBuf> =
            search.groups.iter().map(|group| &group.paths[0]).collect();
        assert_eq!(
            first_paths,
            [
                &folder.path().join("big_y.txt"),
                &folder.path().join("other_a.txt"),
                &folder.path().join("small_a.txt"),
                &folder.path().join("tie_a.txt"),
            ]
        );
        assert_eq!(
            search.groups[0].paths,
            [
                folder.path().join("big_y.txt"),
                folder.path().join("big_z.txt")
            ]
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
