use std::cmp::Ordering;
use std::collections::HashMap;

use crate::cleanup::CleanupGroup;
use crate::perceptual_hash::{HASH_BITS, PerceptualHash};
use crate::photo::{Photo, is_supported_photo, read_photo};
use crate::scan::ScannedFile;
use crate::skipped::SkippedPath;

// Совсем разные картинки совпадают примерно на половину битов, поэтому ниже порог не имеет смысла.
pub const MIN_SIMILARITY_PERCENT: u8 = 50;
pub const MAX_SIMILARITY_PERCENT: u8 = 100;
pub const DEFAULT_SIMILARITY_PERCENT: u8 = 90;

/// Наибольшее расстояние между отпечатками, при котором фото ещё считаются похожими.
pub fn max_hash_distance(similarity_percent: u8) -> u32 {
    let max_percent = u32::from(MAX_SIMILARITY_PERCENT);
    let differing_percent = max_percent.saturating_sub(u32::from(similarity_percent));
    HASH_BITS * differing_percent / max_percent
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimilarPhoto {
    pub file: ScannedFile,
    pub width: u32,
    pub height: u32,
}

impl SimilarPhoto {
    fn pixel_count(&self) -> u64 {
        u64::from(self.width) * u64::from(self.height)
    }
}

impl From<Photo> for SimilarPhoto {
    fn from(photo: Photo) -> Self {
        SimilarPhoto {
            file: photo.file,
            width: photo.width,
            height: photo.height,
        }
    }
}

/// Похожие фото: `best` — то, что стоит оставить, `others` — остальные, по пути.
/// В группе всегда есть хотя бы одно «другое» фото.
#[derive(Debug)]
pub struct SimilarGroup {
    pub best: SimilarPhoto,
    pub others: Vec<SimilarPhoto>,
}

impl SimilarGroup {
    /// Сколько места освободится, если оставить в группе только лучшее фото.
    pub fn reclaimable_bytes(&self) -> u64 {
        self.others.iter().map(|photo| photo.file.size).sum()
    }
}

impl CleanupGroup for SimilarGroup {
    fn kept_file(&self) -> &ScannedFile {
        &self.best.file
    }

    fn extra_files(&self) -> Vec<&ScannedFile> {
        self.others.iter().map(|photo| &photo.file).collect()
    }
}

#[derive(Debug)]
pub struct SimilarSearch {
    pub groups: Vec<SimilarGroup>,
    pub skipped: Vec<SkippedPath>,
}

impl SimilarSearch {
    pub fn reclaimable_bytes(&self) -> u64 {
        self.groups
            .iter()
            .map(SimilarGroup::reclaimable_bytes)
            .sum()
    }
}

pub fn find_similar_photos(files: Vec<ScannedFile>, similarity_percent: u8) -> SimilarSearch {
    let (photos, skipped) = read_photos(files);

    let hashes: Vec<PerceptualHash> = photos.iter().map(|photo| photo.hash).collect();
    let clusters = cluster_similar_hashes(&hashes, max_hash_distance(similarity_percent));
    let similar_photos: Vec<SimilarPhoto> = photos.into_iter().map(SimilarPhoto::from).collect();
    let unsorted_groups = clusters
        .iter()
        .map(|cluster| group_of(cluster, &similar_photos))
        .collect();

    SimilarSearch {
        groups: sorted_groups(unsorted_groups),
        skipped,
    }
}

/// Читает фото, выбранные по расширению; то, что прочитать не удалось, возвращает отдельно.
/// Пустые файлы с расширением картинки не отбрасываем заранее: пусть уйдут в предупреждение.
fn read_photos(files: Vec<ScannedFile>) -> (Vec<Photo>, Vec<SkippedPath>) {
    let mut photos = Vec::new();
    let mut skipped = Vec::new();

    let candidates = files
        .into_iter()
        .filter(|file| is_supported_photo(&file.path));
    for file in candidates {
        match read_photo(file) {
            Ok(photo) => photos.push(photo),
            Err(skipped_path) => skipped.push(skipped_path),
        }
    }

    (photos, skipped)
}

/// Разбивает отпечатки на связные компоненты: два отпечатка связаны, если расстояние между ними
/// не больше `max_distance`, а цепочка похожих тоже считается одной группой.
/// Возвращает индексы по возрастанию; компоненты из одного отпечатка отбрасываются.
fn cluster_similar_hashes(hashes: &[PerceptualHash], max_distance: u32) -> Vec<Vec<usize>> {
    let components = join_similar_hashes(hashes, max_distance);
    clusters_of(components)
}

fn join_similar_hashes(hashes: &[PerceptualHash], max_distance: u32) -> DisjointSets {
    let mut components = DisjointSets::new(hashes.len());
    let pairs = (0..hashes.len())
        .flat_map(|first| ((first + 1)..hashes.len()).map(move |second| (first, second)));

    for (first, second) in pairs {
        if hashes[first].distance(hashes[second]) <= max_distance {
            components.join(first, second);
        }
    }

    components
}

fn clusters_of(mut components: DisjointSets) -> Vec<Vec<usize>> {
    let mut cluster_by_root: HashMap<usize, usize> = HashMap::new();
    let mut clusters: Vec<Vec<usize>> = Vec::new();
    for index in 0..components.len() {
        let root = components.root_of(index);
        let cluster_position = *cluster_by_root.entry(root).or_insert_with(|| {
            clusters.push(Vec::new());
            clusters.len() - 1
        });
        clusters[cluster_position].push(index);
    }

    clusters.retain(|cluster| cluster.len() >= 2);
    clusters
}

struct DisjointSets {
    parents: Vec<usize>,
}

impl DisjointSets {
    fn new(count: usize) -> Self {
        DisjointSets {
            parents: (0..count).collect(),
        }
    }

    fn len(&self) -> usize {
        self.parents.len()
    }

    fn root_of(&mut self, index: usize) -> usize {
        let mut current = index;
        while self.parents[current] != current {
            // Укорачиваем путь, чтобы следующие поиски были быстрее.
            self.parents[current] = self.parents[self.parents[current]];
            current = self.parents[current];
        }
        current
    }

    fn join(&mut self, first: usize, second: usize) {
        let first_root = self.root_of(first);
        let second_root = self.root_of(second);
        self.parents[second_root] = first_root;
    }
}

fn group_of(cluster: &[usize], photos: &[SimilarPhoto]) -> SimilarGroup {
    let cluster_photos = cluster.iter().map(|&index| photos[index].clone()).collect();
    split_best_photo(cluster_photos)
}

/// Лучшее фото — с наибольшим разрешением, затем с большим размером файла, затем с меньшим путём.
fn split_best_photo(photos: Vec<SimilarPhoto>) -> SimilarGroup {
    let best_index = photos
        .iter()
        .enumerate()
        .max_by(|(_, first), (_, second)| quality_order(first, second))
        .map(|(index, _)| index)
        .expect("в группе похожих всегда есть фото");

    let mut others = photos;
    let best = others.remove(best_index);
    others.sort_by(|first, second| first.file.path.cmp(&second.file.path));

    SimilarGroup { best, others }
}

fn quality_order(first: &SimilarPhoto, second: &SimilarPhoto) -> Ordering {
    first
        .pixel_count()
        .cmp(&second.pixel_count())
        .then_with(|| first.file.size.cmp(&second.file.size))
        .then_with(|| second.file.path.cmp(&first.file.path))
}

/// Порядок должен быть одинаковым при каждом запуске, поэтому при равенстве сравниваем пути.
fn sorted_groups(groups: Vec<SimilarGroup>) -> Vec<SimilarGroup> {
    let mut sorted = groups;
    sorted.sort_by(|first, second| {
        second
            .reclaimable_bytes()
            .cmp(&first.reclaimable_bytes())
            .then_with(|| first.best.file.path.cmp(&second.best.file.path))
    });
    sorted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skipped::SkipReason;
    use crate::test_images::scene_image;
    use std::fs;
    use std::path::PathBuf;
    use std::time::SystemTime;
    use tempfile::TempDir;

    const WIDTH: u32 = 64;
    const HEIGHT: u32 = 48;

    fn hash(bits: u64) -> PerceptualHash {
        PerceptualHash::from_bits(bits)
    }

    fn photo(path: &str, width: u32, height: u32, size: u64) -> SimilarPhoto {
        SimilarPhoto {
            file: ScannedFile {
                path: PathBuf::from(path),
                size,
                modified: SystemTime::UNIX_EPOCH,
                identity: None,
            },
            width,
            height,
        }
    }

    fn group(best: SimilarPhoto, others: Vec<SimilarPhoto>) -> SimilarGroup {
        SimilarGroup { best, others }
    }

    fn paths(photos: &[SimilarPhoto]) -> Vec<&str> {
        photos
            .iter()
            .map(|photo| photo.file.path.to_str().unwrap())
            .collect()
    }

    /// Группы в виде значений отпечатков, чтобы сравнивать их независимо от порядка входа.
    fn clusters_as_sorted_bits(hashes: &[PerceptualHash], max_distance: u32) -> Vec<Vec<u64>> {
        let clusters = cluster_similar_hashes(hashes, max_distance);
        let mut as_bits: Vec<Vec<u64>> = clusters
            .iter()
            .map(|cluster| {
                let mut bits: Vec<u64> = cluster.iter().map(|&i| hashes[i].bits()).collect();
                bits.sort();
                bits
            })
            .collect();
        as_bits.sort();
        as_bits
    }

    #[test]
    fn max_distance_follows_similarity_percent() {
        assert_eq!(max_hash_distance(100), 0);
        assert_eq!(max_hash_distance(90), 6);
        assert_eq!(max_hash_distance(50), 32);
    }

    #[test]
    fn max_distance_is_rounded_down() {
        assert_eq!(max_hash_distance(99), 0);
        assert_eq!(max_hash_distance(85), 9);
    }

    #[test]
    fn chain_of_similar_hashes_is_one_group_even_if_ends_differ() {
        // Расстояния: 0b0 ~ 0b11 — 2, 0b11 ~ 0b1111 — 2, а 0b0 и 0b1111 различаются на 4.
        let hashes = [hash(0b0), hash(0b11), hash(0b1111)];

        let clusters = cluster_similar_hashes(&hashes, 2);

        assert_eq!(clusters, vec![vec![0, 1, 2]]);
    }

    #[test]
    fn distant_hashes_form_separate_groups() {
        let hashes = [hash(0), hash(1), hash(u64::MAX), hash(u64::MAX - 1)];

        let clusters = cluster_similar_hashes(&hashes, 1);

        assert_eq!(clusters, vec![vec![0, 1], vec![2, 3]]);
    }

    #[test]
    fn lone_hashes_are_dropped() {
        let hashes = [hash(0), hash(1), hash(u64::MAX)];

        let clusters = cluster_similar_hashes(&hashes, 1);

        assert_eq!(clusters, vec![vec![0, 1]]);
    }

    #[test]
    fn zero_distance_groups_only_identical_hashes() {
        let hashes = [hash(5), hash(6), hash(5)];

        let clusters = cluster_similar_hashes(&hashes, 0);

        assert_eq!(clusters, vec![vec![0, 2]]);
    }

    #[test]
    fn no_hashes_make_no_groups() {
        assert!(cluster_similar_hashes(&[], 6).is_empty());
    }

    #[test]
    fn input_order_does_not_change_groups() {
        let hashes = [
            hash(0b0),
            hash(0b11),
            hash(0b1111),
            hash(u64::MAX),
            hash(u64::MAX - 1),
            hash(1 << 40),
        ];
        let reversed: Vec<PerceptualHash> = hashes.iter().rev().copied().collect();
        let rotated: Vec<PerceptualHash> =
            hashes[2..].iter().chain(&hashes[..2]).copied().collect();

        let expected = clusters_as_sorted_bits(&hashes, 2);

        assert_eq!(clusters_as_sorted_bits(&reversed, 2), expected);
        assert_eq!(clusters_as_sorted_bits(&rotated, 2), expected);
    }

    #[test]
    fn best_photo_has_the_largest_resolution() {
        let result = split_best_photo(vec![
            photo("a.jpg", 100, 100, 9_000),
            photo("b.jpg", 200, 100, 10),
            photo("c.jpg", 100, 150, 20),
        ]);

        assert_eq!(result.best.file.path, PathBuf::from("b.jpg"));
    }

    #[test]
    fn equal_resolution_is_decided_by_larger_file_size() {
        let result = split_best_photo(vec![
            photo("a.jpg", 100, 100, 10),
            photo("b.jpg", 100, 100, 30),
            photo("c.jpg", 100, 100, 20),
        ]);

        assert_eq!(result.best.file.path, PathBuf::from("b.jpg"));
    }

    #[test]
    fn equal_resolution_and_size_are_decided_by_smaller_path() {
        let result = split_best_photo(vec![
            photo("b.jpg", 100, 100, 10),
            photo("a.jpg", 100, 100, 10),
            photo("c.jpg", 100, 100, 10),
        ]);

        assert_eq!(result.best.file.path, PathBuf::from("a.jpg"));
    }

    #[test]
    fn resolution_is_compared_without_overflow() {
        let result = split_best_photo(vec![
            photo("small.jpg", 10, 10, 1),
            photo("huge.jpg", u32::MAX, u32::MAX, 1),
        ]);

        assert_eq!(result.best.file.path, PathBuf::from("huge.jpg"));
    }

    #[test]
    fn other_photos_are_sorted_by_path() {
        let result = split_best_photo(vec![
            photo("z.jpg", 10, 10, 1),
            photo("best.png", 100, 100, 1),
            photo("m.jpg", 10, 10, 1),
            photo("a.jpg", 10, 10, 1),
        ]);

        assert_eq!(paths(&result.others), ["a.jpg", "m.jpg", "z.jpg"]);
    }

    #[test]
    fn reclaimable_bytes_sum_sizes_of_other_photos_only() {
        let result = group(
            photo("best.png", 100, 100, 1_000),
            vec![photo("a.jpg", 10, 10, 30), photo("b.jpg", 10, 10, 12)],
        );

        assert_eq!(result.reclaimable_bytes(), 42);
    }

    #[test]
    fn search_sums_reclaimable_bytes_of_all_groups() {
        let search = SimilarSearch {
            groups: vec![
                group(photo("a.png", 9, 9, 100), vec![photo("b.jpg", 1, 1, 5)]),
                group(photo("c.png", 9, 9, 100), vec![photo("d.jpg", 1, 1, 7)]),
            ],
            skipped: Vec::new(),
        };

        assert_eq!(search.reclaimable_bytes(), 12);
    }

    #[test]
    fn groups_are_ordered_by_reclaimable_bytes_then_by_best_path() {
        let groups = vec![
            group(photo("b.png", 9, 9, 1), vec![photo("b2.jpg", 1, 1, 10)]),
            group(photo("c.png", 9, 9, 1), vec![photo("c2.jpg", 1, 1, 50)]),
            group(photo("a.png", 9, 9, 1), vec![photo("a2.jpg", 1, 1, 10)]),
        ];

        let sorted = sorted_groups(groups);

        let best_paths: Vec<&str> = sorted
            .iter()
            .map(|group| group.best.file.path.to_str().unwrap())
            .collect();
        assert_eq!(best_paths, ["c.png", "a.png", "b.png"]);
    }

    fn scanned_file(folder: &TempDir, name: &str) -> ScannedFile {
        let path = folder.path().join(name);
        let metadata = fs::metadata(&path).unwrap();
        ScannedFile::from_metadata(path, &metadata).unwrap()
    }

    #[test]
    fn search_ignores_non_photos_and_reports_broken_photos() {
        let folder = TempDir::new().unwrap();
        scene_image(WIDTH, HEIGHT)
            .save(folder.path().join("a.png"))
            .unwrap();
        scene_image(WIDTH, HEIGHT)
            .save(folder.path().join("b.png"))
            .unwrap();
        fs::write(folder.path().join("notes.txt"), "заметки").unwrap();
        fs::write(folder.path().join("broken.jpg"), "не картинка").unwrap();
        let files = ["a.png", "b.png", "notes.txt", "broken.jpg"]
            .iter()
            .map(|name| scanned_file(&folder, name))
            .collect();

        let search = find_similar_photos(files, DEFAULT_SIMILARITY_PERCENT);

        assert_eq!(search.groups.len(), 1);
        assert_eq!(search.groups[0].others.len(), 1);
        assert_eq!(search.skipped.len(), 1);
        assert_eq!(search.skipped[0].reason, SkipReason::DamagedImage);
    }

    #[test]
    fn empty_file_with_picture_extension_is_reported_not_dropped() {
        let folder = TempDir::new().unwrap();
        fs::write(folder.path().join("empty.png"), "").unwrap();
        let files = vec![scanned_file(&folder, "empty.png")];

        let search = find_similar_photos(files, DEFAULT_SIMILARITY_PERCENT);

        assert!(search.groups.is_empty());
        assert_eq!(search.skipped.len(), 1);
        assert_eq!(search.skipped[0].reason, SkipReason::DamagedImage);
    }
}
