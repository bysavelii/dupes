use crate::cleanup::{Cleanup, CleanupGroup, CleanupSummary, ExtraStatus, count_extra_files};
use crate::duplicates::{DuplicateGroup, DuplicateSearch};
use crate::similar::{SimilarGroup, SimilarPhoto, SimilarSearch};
use crate::skipped::SkippedPath;

const BYTES_PER_UNIT_STEP: u64 = 1024;
const TENTHS_PER_WHOLE: u64 = 10;
const TENTHS_PER_UNIT_STEP: u64 = BYTES_PER_UNIT_STEP * TENTHS_PER_WHOLE;
const SIZE_UNITS: [&str; 5] = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
const NO_DUPLICATES_MESSAGE: &str = "Одинаковых файлов не найдено.";
const NO_SIMILAR_PHOTOS_MESSAGE: &str = "Похожих фото не найдено.";
const LINE_INDENT: &str = "  ";
const OLDEST_FILE_LABEL: &str = "(самый старый)";
const BEST_QUALITY_LABEL: &str = "(лучшее качество)";
const OLDEST_FILE_RULE: &str = "только самый старый файл";
const BEST_QUALITY_RULE: &str = "только фото в лучшем качестве";
const KEPT_PREFIX: &str = "остаётся: ";
const WILL_BE_TRASHED_PREFIX: &str = "в корзину: ";
const TRASHED_PREFIX: &str = "перенесён в корзину: ";
const NOT_TRASHED_PREFIX: &str = "не перенесён: ";
const TRASH_HINT: &str = "Чтобы убрать лишние файлы в корзину, повторите команду, добавив --trash: сначала будет показано, что именно переносится.";
const PREVIEW_NOTICE: &str = "Это пробный запуск: файлы остались на месте. Чтобы перенести лишние файлы в корзину, повторите команду, добавив --yes.";
const NOTHING_TRASHED_MESSAGE: &str = "Ни один файл не перенесён в корзину.";
const TRASH_REMINDER: &str =
    "Место освободится, когда вы очистите корзину; до тех пор файлы можно вернуть из неё.";
const BLOCK_SEPARATOR: &str = "\n\n";

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

/// Строки одной группы: заголовок, оставляемый файл (с пометкой) и лишние файлы.
struct GroupText {
    title: String,
    kept_description: String,
    extra_descriptions: Vec<String>,
}

pub fn format_duplicates_report(search: &DuplicateSearch, cleanup: &Cleanup) -> String {
    if search.groups.is_empty() {
        return NO_DUPLICATES_MESSAGE.to_string();
    }

    let header = format!("Найдено групп одинаковых файлов: {}.", search.groups.len());
    let group_blocks = search.groups.iter().enumerate().map(|(index, group)| {
        format_group_block(duplicate_group_text(index + 1, group), index, cleanup)
    });
    let footer = format_footer(
        &search.groups,
        search.reclaimable_bytes(),
        OLDEST_FILE_RULE,
        cleanup,
    );

    join_blocks(header, group_blocks, footer)
}

pub fn format_similar_report(search: &SimilarSearch, cleanup: &Cleanup) -> String {
    if search.groups.is_empty() {
        return NO_SIMILAR_PHOTOS_MESSAGE.to_string();
    }

    let header = format!("Найдено групп похожих фото: {}.", search.groups.len());
    let group_blocks = search.groups.iter().enumerate().map(|(index, group)| {
        format_group_block(similar_group_text(index + 1, group), index, cleanup)
    });
    let footer = format_footer(
        &search.groups,
        search.reclaimable_bytes(),
        BEST_QUALITY_RULE,
        cleanup,
    );

    join_blocks(header, group_blocks, footer)
}

pub fn format_skipped(skipped: &SkippedPath) -> String {
    format!(
        "Не удалось прочитать «{}»: {}. Пропускаю.",
        skipped.path.display(),
        skipped.reason
    )
}

fn join_blocks(
    header: String,
    group_blocks: impl Iterator<Item = String>,
    footer: String,
) -> String {
    let mut blocks = vec![header];
    blocks.extend(group_blocks);
    blocks.push(footer);
    blocks.join(BLOCK_SEPARATOR)
}

fn duplicate_group_text(number: usize, group: &DuplicateGroup) -> GroupText {
    let file_count = group.copies.len() + 1;
    let title = format!(
        "Группа {number}: файлов — {file_count}, размер каждого — {}",
        format_size(group.size())
    );

    GroupText {
        title,
        kept_description: format!("{} {OLDEST_FILE_LABEL}", group.kept.path.display()),
        extra_descriptions: group
            .copies
            .iter()
            .map(|copy| copy.path.display().to_string())
            .collect(),
    }
}

fn similar_group_text(number: usize, group: &SimilarGroup) -> GroupText {
    let photo_count = group.others.len() + 1;

    GroupText {
        title: format!("Группа {number}: фото — {photo_count}"),
        kept_description: format!("{} {BEST_QUALITY_LABEL}", format_photo(&group.best)),
        extra_descriptions: group.others.iter().map(format_photo).collect(),
    }
}

fn format_photo(photo: &SimilarPhoto) -> String {
    format!(
        "{} — {}×{}, {}",
        photo.file.path.display(),
        photo.width,
        photo.height,
        format_size(photo.file.size)
    )
}

fn format_group_block(group: GroupText, group_index: usize, cleanup: &Cleanup) -> String {
    let kept_line = format_kept_line(&group.kept_description, cleanup);
    let extra_lines =
        group
            .extra_descriptions
            .iter()
            .enumerate()
            .map(|(extra_index, description)| {
                let status = cleanup.extra_status(group_index, extra_index);
                format_extra_line(description, status)
            });

    let mut lines = vec![group.title, kept_line];
    lines.extend(extra_lines);
    lines.join("\n")
}

fn format_kept_line(description: &str, cleanup: &Cleanup) -> String {
    match cleanup {
        Cleanup::ReportOnly => format!("{LINE_INDENT}{description}"),
        Cleanup::Preview | Cleanup::Done(_) => format!("{LINE_INDENT}{KEPT_PREFIX}{description}"),
    }
}

fn format_extra_line(description: &str, status: ExtraStatus) -> String {
    match status {
        ExtraStatus::Listed => format!("{LINE_INDENT}{description}"),
        ExtraStatus::WillBeTrashed => {
            format!("{LINE_INDENT}{WILL_BE_TRASHED_PREFIX}{description}")
        }
        ExtraStatus::Trashed => format!("{LINE_INDENT}{TRASHED_PREFIX}{description}"),
        ExtraStatus::NotTrashed(failure) => {
            format!("{LINE_INDENT}{NOT_TRASHED_PREFIX}{description} — {failure}")
        }
    }
}

fn format_footer<Group: CleanupGroup>(
    groups: &[Group],
    reclaimable_bytes: u64,
    kept_rule: &str,
    cleanup: &Cleanup,
) -> String {
    match cleanup {
        Cleanup::ReportOnly => format!(
            "Если оставить в каждой группе {kept_rule}, освободится {}.\n{TRASH_HINT}",
            format_size(reclaimable_bytes)
        ),
        Cleanup::Preview => format!(
            "Будет перенесено в корзину файлов — {} ({}).\n{PREVIEW_NOTICE}",
            count_extra_files(groups),
            format_size(reclaimable_bytes)
        ),
        Cleanup::Done(outcomes_by_group) => {
            format_done_footer(&CleanupSummary::of(groups, outcomes_by_group))
        }
    }
}

fn format_done_footer(summary: &CleanupSummary) -> String {
    let trashed_line = format_trashed_line(summary);
    if summary.failed_count == 0 {
        return trashed_line;
    }

    let failed_line = format!(
        "Не удалось перенести файлов — {}: они остались на месте, причины указаны выше.",
        summary.failed_count
    );
    format!("{trashed_line}\n{failed_line}")
}

fn format_trashed_line(summary: &CleanupSummary) -> String {
    if summary.trashed_count == 0 {
        return NOTHING_TRASHED_MESSAGE.to_string();
    }

    format!(
        "Перенесено в корзину файлов — {} ({}). {TRASH_REMINDER}",
        summary.trashed_count,
        format_size(summary.trashed_bytes)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cleanup::{TrashFailure, TrashOutcome};
    use crate::scan::ScannedFile;
    use crate::skipped::SkipReason;
    use std::path::PathBuf;
    use std::time::SystemTime;

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

    fn scanned(path: &str, size: u64) -> ScannedFile {
        ScannedFile {
            path: path.into(),
            size,
            modified: SystemTime::UNIX_EPOCH,
            identity: None,
        }
    }

    fn duplicate_search() -> DuplicateSearch {
        let size = MEBIBYTE + MEBIBYTE / 2;
        DuplicateSearch {
            groups: vec![
                DuplicateGroup {
                    kept: scanned("a/one.bin", size),
                    copies: vec![scanned("b/two.bin", size), scanned("c/three.bin", size)],
                },
                DuplicateGroup {
                    kept: scanned("x.txt", 512),
                    copies: vec![scanned("y.txt", 512)],
                },
            ],
            skipped: Vec::new(),
        }
    }

    #[test]
    fn empty_search_says_nothing_found_for_every_action() {
        let search = DuplicateSearch {
            groups: Vec::new(),
            skipped: Vec::new(),
        };
        let no_outcomes: [Vec<TrashOutcome>; 0] = [];

        for cleanup in [
            Cleanup::ReportOnly,
            Cleanup::Preview,
            Cleanup::Done(&no_outcomes),
        ] {
            assert_eq!(
                format_duplicates_report(&search, &cleanup),
                "Одинаковых файлов не найдено."
            );
        }
    }

    #[test]
    fn report_lists_oldest_file_first_and_reclaimable_size() {
        let expected = "\
Найдено групп одинаковых файлов: 2.

Группа 1: файлов — 3, размер каждого — 1,5 МБ
  a/one.bin (самый старый)
  b/two.bin
  c/three.bin

Группа 2: файлов — 2, размер каждого — 512 Б
  x.txt (самый старый)
  y.txt

Если оставить в каждой группе только самый старый файл, освободится 3,0 МБ.
Чтобы убрать лишние файлы в корзину, повторите команду, добавив --trash: сначала будет показано, что именно переносится.";
        assert_eq!(
            format_duplicates_report(&duplicate_search(), &Cleanup::ReportOnly),
            expected
        );
    }

    #[test]
    fn preview_shows_what_stays_and_what_goes_to_trash() {
        let expected = "\
Найдено групп одинаковых файлов: 2.

Группа 1: файлов — 3, размер каждого — 1,5 МБ
  остаётся: a/one.bin (самый старый)
  в корзину: b/two.bin
  в корзину: c/three.bin

Группа 2: файлов — 2, размер каждого — 512 Б
  остаётся: x.txt (самый старый)
  в корзину: y.txt

Будет перенесено в корзину файлов — 3 (3,0 МБ).
Это пробный запуск: файлы остались на месте. Чтобы перенести лишние файлы в корзину, повторите команду, добавив --yes.";
        assert_eq!(
            format_duplicates_report(&duplicate_search(), &Cleanup::Preview),
            expected
        );
    }

    #[test]
    fn done_report_shows_each_outcome_and_totals() {
        let outcomes = vec![
            vec![Ok(()), Err(TrashFailure::ChangedSinceScan)],
            vec![Ok(())],
        ];
        let expected = "\
Найдено групп одинаковых файлов: 2.

Группа 1: файлов — 3, размер каждого — 1,5 МБ
  остаётся: a/one.bin (самый старый)
  перенесён в корзину: b/two.bin
  не перенесён: c/three.bin — файл изменился после проверки

Группа 2: файлов — 2, размер каждого — 512 Б
  остаётся: x.txt (самый старый)
  перенесён в корзину: y.txt

Перенесено в корзину файлов — 2 (1,5 МБ). Место освободится, когда вы очистите корзину; до тех пор файлы можно вернуть из неё.
Не удалось перенести файлов — 1: они остались на месте, причины указаны выше.";
        assert_eq!(
            format_duplicates_report(&duplicate_search(), &Cleanup::Done(&outcomes)),
            expected
        );
    }

    #[test]
    fn done_report_without_any_trashed_file_does_not_promise_free_space() {
        let outcomes = vec![
            vec![Err(TrashFailure::AccessDenied), Err(TrashFailure::Vanished)],
            vec![Err(TrashFailure::SameFileAsKept)],
        ];

        let report = format_duplicates_report(&duplicate_search(), &Cleanup::Done(&outcomes));

        assert!(
            report.ends_with(
                "Ни один файл не перенесён в корзину.\nНе удалось перенести файлов — 3: они остались на месте, причины указаны выше."
            ),
            "{report}"
        );
        assert!(!report.contains("Место освободится"), "{report}");
        assert!(!report.contains("Перенесено в корзину файлов"), "{report}");
    }

    #[test]
    fn done_report_without_failures_has_no_failure_line() {
        let outcomes = vec![vec![Ok(()), Ok(())], vec![Ok(())]];

        let report = format_duplicates_report(&duplicate_search(), &Cleanup::Done(&outcomes));

        assert!(
            report.ends_with(
                "Перенесено в корзину файлов — 3 (3,0 МБ). Место освободится, когда вы очистите корзину; до тех пор файлы можно вернуть из неё."
            ),
            "{report}"
        );
        assert!(!report.contains("Не удалось перенести"), "{report}");
    }

    fn similar_photo(path: &str, width: u32, height: u32, size: u64) -> SimilarPhoto {
        SimilarPhoto {
            file: scanned(path, size),
            width,
            height,
        }
    }

    fn similar_search() -> SimilarSearch {
        SimilarSearch {
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
        }
    }

    #[test]
    fn empty_similar_search_says_nothing_found_for_every_action() {
        let search = SimilarSearch {
            groups: Vec::new(),
            skipped: Vec::new(),
        };
        let no_outcomes: [Vec<TrashOutcome>; 0] = [];

        for cleanup in [
            Cleanup::ReportOnly,
            Cleanup::Preview,
            Cleanup::Done(&no_outcomes),
        ] {
            assert_eq!(
                format_similar_report(&search, &cleanup),
                "Похожих фото не найдено."
            );
        }
    }

    #[test]
    fn similar_report_lists_best_photo_first_and_reclaimable_size() {
        let expected = "\
Найдено групп похожих фото: 2.

Группа 1: фото — 3
  photos/original.png — 640×480, 1,2 МБ (лучшее качество)
  photos/copy.jpg — 160×120, 8,0 КБ
  photos/recompressed.jpg — 640×480, 30,0 КБ

Группа 2: фото — 2
  trip/a.jpg — 100×50, 2,0 КБ (лучшее качество)
  trip/b.jpg — 50×25, 512 Б

Если оставить в каждой группе только фото в лучшем качестве, освободится 38,5 КБ.
Чтобы убрать лишние файлы в корзину, повторите команду, добавив --trash: сначала будет показано, что именно переносится.";
        assert_eq!(
            format_similar_report(&similar_search(), &Cleanup::ReportOnly),
            expected
        );
    }

    #[test]
    fn similar_preview_shows_what_stays_and_what_goes_to_trash() {
        let expected = "\
Найдено групп похожих фото: 2.

Группа 1: фото — 3
  остаётся: photos/original.png — 640×480, 1,2 МБ (лучшее качество)
  в корзину: photos/copy.jpg — 160×120, 8,0 КБ
  в корзину: photos/recompressed.jpg — 640×480, 30,0 КБ

Группа 2: фото — 2
  остаётся: trip/a.jpg — 100×50, 2,0 КБ (лучшее качество)
  в корзину: trip/b.jpg — 50×25, 512 Б

Будет перенесено в корзину файлов — 3 (38,5 КБ).
Это пробный запуск: файлы остались на месте. Чтобы перенести лишние файлы в корзину, повторите команду, добавив --yes.";
        assert_eq!(
            format_similar_report(&similar_search(), &Cleanup::Preview),
            expected
        );
    }

    #[test]
    fn similar_done_report_shows_each_outcome_and_totals() {
        let outcomes = vec![
            vec![
                Err(TrashFailure::KeptFileChanged),
                Err(TrashFailure::Vanished),
            ],
            vec![Ok(())],
        ];
        let expected = "\
Найдено групп похожих фото: 2.

Группа 1: фото — 3
  остаётся: photos/original.png — 640×480, 1,2 МБ (лучшее качество)
  не перенесён: photos/copy.jpg — 160×120, 8,0 КБ — файл, который должен остаться, изменился, пропал или недоступен — группа не тронута
  не перенесён: photos/recompressed.jpg — 640×480, 30,0 КБ — файл пропал после проверки

Группа 2: фото — 2
  остаётся: trip/a.jpg — 100×50, 2,0 КБ (лучшее качество)
  перенесён в корзину: trip/b.jpg — 50×25, 512 Б

Перенесено в корзину файлов — 1 (512 Б). Место освободится, когда вы очистите корзину; до тех пор файлы можно вернуть из неё.
Не удалось перенести файлов — 2: они остались на месте, причины указаны выше.";
        assert_eq!(
            format_similar_report(&similar_search(), &Cleanup::Done(&outcomes)),
            expected
        );
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
