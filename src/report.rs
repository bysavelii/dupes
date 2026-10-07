use crate::duplicates::{DuplicateGroup, DuplicateSearch};
use crate::similar::{SimilarGroup, SimilarPhoto, SimilarSearch};
use crate::skipped::SkippedPath;

const BYTES_PER_UNIT_STEP: u64 = 1024;
const TENTHS_PER_WHOLE: u64 = 10;
const TENTHS_PER_UNIT_STEP: u64 = BYTES_PER_UNIT_STEP * TENTHS_PER_WHOLE;
const SIZE_UNITS: [&str; 5] = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
const NO_DUPLICATES_MESSAGE: &str = "Одинаковых файлов не найдено.";
const NO_SIMILAR_PHOTOS_MESSAGE: &str = "Похожих фото не найдено.";
const PATH_INDENT: &str = "  ";

pub fn format_size(bytes: u64) -> String {
    if bytes < BYTES_PER_UNIT_STEP {
        return format!("{bytes} {}", SIZE_UNITS[0]);
    }

    let last_unit_index = SIZE_UNITS.len() - 1;
    let mut value = bytes as f64;
    let mut unit_index = 0;
    // Единицу выбираем по значению после округления: 1023,96 КБ — это уже «1,0 МБ», а не «1024,0 КБ».
    while rounded_tenths(value) >= TENTHS_PER_UNIT_STEP && unit_index < last_unit_index {
        value /= BYTES_PER_UNIT_STEP as f64;
        unit_index += 1;
    }

    let tenths = rounded_tenths(value);
    let whole_part = tenths / TENTHS_PER_WHOLE;
    let tenth_part = tenths % TENTHS_PER_WHOLE;
    format!("{whole_part},{tenth_part} {}", SIZE_UNITS[unit_index])
}

fn rounded_tenths(value: f64) -> u64 {
    (value * TENTHS_PER_WHOLE as f64).round() as u64
}

pub fn format_duplicates_report(search: &DuplicateSearch) -> String {
    if search.groups.is_empty() {
        return NO_DUPLICATES_MESSAGE.to_string();
    }

    let header = format!("Найдено групп одинаковых файлов: {}.", search.groups.len());
    let group_blocks = search
        .groups
        .iter()
        .enumerate()
        .map(|(index, group)| format_group(index + 1, group));
    let footer = format!(
        "Если оставить по одному файлу из каждой группы, освободится {}.",
        format_size(search.reclaimable_bytes())
    );

    let mut blocks = vec![header];
    blocks.extend(group_blocks);
    blocks.push(footer);
    blocks.join("\n\n")
}

pub fn format_similar_report(search: &SimilarSearch) -> String {
    if search.groups.is_empty() {
        return NO_SIMILAR_PHOTOS_MESSAGE.to_string();
    }

    let header = format!("Найдено групп похожих фото: {}.", search.groups.len());
    let group_blocks = search
        .groups
        .iter()
        .enumerate()
        .map(|(index, group)| format_similar_group(index + 1, group));
    let footer = format!(
        "Если оставить в каждой группе только фото в лучшем качестве, освободится {}.",
        format_size(search.reclaimable_bytes())
    );

    let mut blocks = vec![header];
    blocks.extend(group_blocks);
    blocks.push(footer);
    blocks.join("\n\n")
}

pub fn format_skipped(skipped: &SkippedPath) -> String {
    format!(
        "Не удалось прочитать «{}»: {}. Пропускаю.",
        skipped.path.display(),
        skipped.reason
    )
}

fn format_group(number: usize, group: &DuplicateGroup) -> String {
    let title = format!(
        "Группа {number}: файлов — {}, размер каждого — {}",
        group.paths.len(),
        format_size(group.size)
    );
    let path_lines = group
        .paths
        .iter()
        .map(|path| format!("{PATH_INDENT}{}", path.display()));

    let mut lines = vec![title];
    lines.extend(path_lines);
    lines.join("\n")
}

fn format_similar_group(number: usize, group: &SimilarGroup) -> String {
    let photo_count = group.others.len() + 1;
    let title = format!("Группа {number}: фото — {photo_count}");
    let best_line = format!(
        "{PATH_INDENT}{} (лучшее качество)",
        format_photo(&group.best)
    );
    let other_lines = group
        .others
        .iter()
        .map(|photo| format!("{PATH_INDENT}{}", format_photo(photo)));

    let mut lines = vec![title, best_line];
    lines.extend(other_lines);
    lines.join("\n")
}

fn format_photo(photo: &SimilarPhoto) -> String {
    format!(
        "{} — {}×{}, {}",
        photo.path.display(),
        photo.width,
        photo.height,
        format_size(photo.size)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skipped::SkipReason;
    use std::path::PathBuf;

    const MEBIBYTE: u64 = 1024 * 1024;
    const GIBIBYTE: u64 = 1024 * MEBIBYTE;

    #[test]
    fn small_sizes_are_whole_bytes() {
        assert_eq!(format_size(0), "0 Б");
        assert_eq!(format_size(512), "512 Б");
        assert_eq!(format_size(1023), "1023 Б");
    }

    #[test]
    fn larger_sizes_have_one_decimal_with_comma() {
        assert_eq!(format_size(1024), "1,0 КБ");
        assert_eq!(format_size(1536), "1,5 КБ");
        assert_eq!(format_size(MEBIBYTE), "1,0 МБ");
        assert_eq!(format_size(5 * GIBIBYTE), "5,0 ГБ");
    }

    #[test]
    fn size_just_below_next_unit_rounds_up_to_it() {
        assert_eq!(format_size(MEBIBYTE - 1), "1,0 МБ");
        assert_eq!(format_size(GIBIBYTE - 1), "1,0 ГБ");
        assert_eq!(format_size(1024 * GIBIBYTE - 1), "1,0 ТБ");
    }

    #[test]
    fn size_that_rounds_down_stays_in_its_unit() {
        assert_eq!(format_size(MEBIBYTE - 1024), "1023,0 КБ");
    }

    #[test]
    fn huge_sizes_stay_in_terabytes() {
        assert_eq!(format_size(2048 * GIBIBYTE * 1024), "2048,0 ТБ");
    }

    #[test]
    fn empty_search_says_nothing_found() {
        let search = DuplicateSearch {
            groups: Vec::new(),
            skipped: Vec::new(),
        };

        assert_eq!(
            format_duplicates_report(&search),
            "Одинаковых файлов не найдено."
        );
    }

    #[test]
    fn report_lists_groups_and_reclaimable_size() {
        let search = DuplicateSearch {
            groups: vec![
                DuplicateGroup {
                    size: MEBIBYTE + MEBIBYTE / 2,
                    paths: vec!["a/one.bin".into(), "b/two.bin".into(), "c/three.bin".into()],
                },
                DuplicateGroup {
                    size: 512,
                    paths: vec!["x.txt".into(), "y.txt".into()],
                },
            ],
            skipped: Vec::new(),
        };

        let expected = "\
Найдено групп одинаковых файлов: 2.

Группа 1: файлов — 3, размер каждого — 1,5 МБ
  a/one.bin
  b/two.bin
  c/three.bin

Группа 2: файлов — 2, размер каждого — 512 Б
  x.txt
  y.txt

Если оставить по одному файлу из каждой группы, освободится 3,0 МБ.";
        assert_eq!(format_duplicates_report(&search), expected);
    }

    fn similar_photo(path: &str, width: u32, height: u32, size: u64) -> SimilarPhoto {
        SimilarPhoto {
            path: path.into(),
            size,
            width,
            height,
        }
    }

    #[test]
    fn empty_similar_search_says_nothing_found() {
        let search = SimilarSearch {
            groups: Vec::new(),
            skipped: Vec::new(),
        };

        assert_eq!(format_similar_report(&search), "Похожих фото не найдено.");
    }

    #[test]
    fn similar_report_lists_best_photo_first_and_reclaimable_size() {
        let search = SimilarSearch {
            groups: vec![
                SimilarGroup {
                    best: similar_photo("photos/original.png", 640, 480, MEBIBYTE + MEBIBYTE / 5),
                    others: vec![
                        similar_photo("photos/copy.jpg", 160, 120, 8 * 1024),
                        similar_photo("photos/recompressed.jpg", 640, 480, 30 * 1024),
                    ],
                },
                SimilarGroup {
                    best: similar_photo("trip/a.jpg", 100, 50, 2048),
                    others: vec![similar_photo("trip/b.jpg", 50, 25, 512)],
                },
            ],
            skipped: Vec::new(),
        };

        let expected = "\
Найдено групп похожих фото: 2.

Группа 1: фото — 3
  photos/original.png — 640×480, 1,2 МБ (лучшее качество)
  photos/copy.jpg — 160×120, 8,0 КБ
  photos/recompressed.jpg — 640×480, 30,0 КБ

Группа 2: фото — 2
  trip/a.jpg — 100×50, 2,0 КБ (лучшее качество)
  trip/b.jpg — 50×25, 512 Б

Если оставить в каждой группе только фото в лучшем качестве, освободится 38,5 КБ.";
        assert_eq!(format_similar_report(&search), expected);
    }

    #[test]
    fn skipped_path_is_explained() {
        let skipped = SkippedPath {
            path: PathBuf::from("docs/secret.txt"),
            reason: SkipReason::AccessDenied,
        };

        assert_eq!(
            format_skipped(&skipped),
            "Не удалось прочитать «docs/secret.txt»: нет прав на чтение. Пропускаю."
        );
    }
}
