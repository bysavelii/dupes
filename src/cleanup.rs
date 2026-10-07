use std::fmt;
use std::io;
use std::path::Path;

use crate::scan::{FileCheck, ScannedFile, check_unchanged};

/// Почему лишний файл не удалось перенести в корзину.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrashFailure {
    KeptFileChanged,
    SameFileAsKept,
    ChangedSinceScan,
    Vanished,
    AccessDenied,
    Unexpected(String),
}

impl TrashFailure {
    /// Стабильное имя причины для скриптов: не меняется вместе с русским текстом.
    pub fn code(&self) -> &'static str {
        match self {
            TrashFailure::KeptFileChanged => "kept_file_changed",
            TrashFailure::SameFileAsKept => "same_file_as_kept",
            TrashFailure::ChangedSinceScan => "changed_since_scan",
            TrashFailure::Vanished => "vanished",
            TrashFailure::AccessDenied => "access_denied",
            TrashFailure::Unexpected(_) => "unexpected",
        }
    }
}

impl From<&io::Error> for TrashFailure {
    fn from(error: &io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::PermissionDenied => TrashFailure::AccessDenied,
            io::ErrorKind::NotFound => TrashFailure::Vanished,
            _ => TrashFailure::Unexpected(error.to_string()),
        }
    }
}

impl fmt::Display for TrashFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TrashFailure::KeptFileChanged => write!(
                formatter,
                "файл, который должен остаться, изменился, пропал или недоступен — группа не тронута"
            ),
            TrashFailure::SameFileAsKept => write!(
                formatter,
                "это тот же файл, что и оставляемый, — не переносится"
            ),
            TrashFailure::ChangedSinceScan => write!(formatter, "файл изменился после проверки"),
            TrashFailure::Vanished => write!(formatter, "файл пропал после проверки"),
            TrashFailure::AccessDenied => write!(formatter, "нет прав, чтобы перенести файл"),
            TrashFailure::Unexpected(system_message) => write!(
                formatter,
                "непредвиденная ошибка (системное сообщение: {system_message})"
            ),
        }
    }
}

pub type TrashOutcome = Result<(), TrashFailure>;

/// Что сделано с лишними файлами найденных групп.
pub enum Cleanup<'a> {
    /// Только отчёт: про корзину ничего не сказано.
    ReportOnly,
    /// Пробный запуск: показано, что будет перенесено, файлы на месте.
    Preview,
    /// Перенос выполнен; результаты выровнены по группам и их лишним файлам.
    Done(&'a [Vec<TrashOutcome>]),
}

/// Что известно о судьбе одного лишнего файла.
pub enum ExtraStatus<'a> {
    Listed,
    WillBeTrashed,
    Trashed,
    NotTrashed(&'a TrashFailure),
}

impl<'a> Cleanup<'a> {
    pub fn extra_status(&self, group_index: usize, extra_index: usize) -> ExtraStatus<'a> {
        match self {
            Cleanup::ReportOnly => ExtraStatus::Listed,
            Cleanup::Preview => ExtraStatus::WillBeTrashed,
            Cleanup::Done(outcomes_by_group) => {
                match &outcomes_by_group[group_index][extra_index] {
                    Ok(()) => ExtraStatus::Trashed,
                    Err(failure) => ExtraStatus::NotTrashed(failure),
                }
            }
        }
    }
}

/// Группа, в которой один файл остаётся, а остальные можно перенести в корзину.
pub trait CleanupGroup {
    fn kept_file(&self) -> &ScannedFile;

    fn extra_files(&self) -> Vec<&ScannedFile>;
}

/// Итог переноса по всем группам.
#[derive(Debug, PartialEq, Eq)]
pub struct CleanupSummary {
    pub trashed_count: usize,
    pub trashed_bytes: u64,
    pub failed_count: usize,
}

impl CleanupSummary {
    /// `outcomes_by_group` выровнены по группам и их лишним файлам, как их вернул `trash_groups`.
    pub fn of<Group: CleanupGroup>(
        groups: &[Group],
        outcomes_by_group: &[Vec<TrashOutcome>],
    ) -> Self {
        let mut summary = CleanupSummary {
            trashed_count: 0,
            trashed_bytes: 0,
            failed_count: 0,
        };

        let extras_with_outcomes = groups
            .iter()
            .zip(outcomes_by_group)
            .flat_map(|(group, outcomes)| group.extra_files().into_iter().zip(outcomes));
        for (extra, outcome) in extras_with_outcomes {
            match outcome {
                Ok(()) => {
                    summary.trashed_count += 1;
                    summary.trashed_bytes += extra.size;
                }
                Err(_) => summary.failed_count += 1,
            }
        }

        summary
    }
}

pub fn count_extra_files<Group: CleanupGroup>(groups: &[Group]) -> usize {
    groups.iter().map(|group| group.extra_files().len()).sum()
}

/// Переносит лишние файлы каждой группы; результаты идут в порядке групп и их лишних файлов.
pub fn trash_groups<Group: CleanupGroup>(
    groups: &[Group],
    move_to_trash: &mut impl FnMut(&Path) -> TrashOutcome,
) -> Vec<Vec<TrashOutcome>> {
    groups
        .iter()
        .map(|group| trash_extra_files(group.kept_file(), group.extra_files(), move_to_trash))
        .collect()
}

/// Переносит лишние файлы группы, не трогая оставляемый. Между проверкой папки и переносом
/// файлы могли измениться, поэтому каждый перепроверяется: изменившийся не переносится.
/// Если оставляемый изменился, пропал или его не удалось проверить, группа не трогается совсем:
/// лишние файлы могли перестать быть копиями.
/// Результаты идут в порядке `extras`; ошибка на одном файле не останавливает остальные.
pub fn trash_extra_files<'a>(
    kept: &ScannedFile,
    extras: impl IntoIterator<Item = &'a ScannedFile>,
    move_to_trash: &mut impl FnMut(&Path) -> TrashOutcome,
) -> Vec<TrashOutcome> {
    let extras = extras.into_iter();
    let is_kept_file_unchanged = matches!(check_unchanged(kept), FileCheck::Unchanged);
    if !is_kept_file_unchanged {
        return extras.map(|_| Err(TrashFailure::KeptFileChanged)).collect();
    }

    extras
        .map(|extra| trash_extra_file(kept, extra, move_to_trash))
        .collect()
}

fn trash_extra_file(
    kept: &ScannedFile,
    extra: &ScannedFile,
    move_to_trash: &mut impl FnMut(&Path) -> TrashOutcome,
) -> TrashOutcome {
    match check_unchanged(extra) {
        FileCheck::Unchanged if is_same_physical_file(kept, extra) => {
            Err(TrashFailure::SameFileAsKept)
        }
        FileCheck::Unchanged => move_to_trash(&extra.path),
        FileCheck::Changed => Err(TrashFailure::ChangedSinceScan),
        FileCheck::Vanished => Err(TrashFailure::Vanished),
        FileCheck::Failed(error) => Err(TrashFailure::from(&error)),
    }
}

/// Страховка: проверка папки уже оставляет один путь на физический файл, а подмену файла после
/// неё ловит перепроверка. Но если в группу всё же попали два пути к одному файлу, перенос
/// лишнего убрал бы и оставляемый.
fn is_same_physical_file(kept: &ScannedFile, extra: &ScannedFile) -> bool {
    kept.identity.is_some() && kept.identity == extra.identity
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::scan_folder;
    use std::fs::{self, File};
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime};
    use tempfile::TempDir;

    const ONE_HOUR: Duration = Duration::from_secs(3600);

    /// Подменная функция переноса: запоминает пути и отказывает на заданном.
    struct FakeTrash {
        moved: Vec<PathBuf>,
        refused: Option<PathBuf>,
    }

    impl FakeTrash {
        fn accepting_everything() -> Self {
            FakeTrash {
                moved: Vec::new(),
                refused: None,
            }
        }

        fn refusing(path: PathBuf) -> Self {
            FakeTrash {
                moved: Vec::new(),
                refused: Some(path),
            }
        }

        fn move_to_trash(&mut self, path: &Path) -> TrashOutcome {
            if self.refused.as_deref() == Some(path) {
                return Err(TrashFailure::AccessDenied);
            }
            self.moved.push(path.to_path_buf());
            Ok(())
        }
    }

    fn trash_with(
        fake: &mut FakeTrash,
        kept: &ScannedFile,
        extras: &[ScannedFile],
    ) -> Vec<TrashOutcome> {
        trash_extra_files(kept, extras, &mut |path| fake.move_to_trash(path))
    }

    /// Файлы с разным содержимым, чтобы размеры в тестах различались.
    fn scan_files(folder: &TempDir, names: &[&str]) -> Vec<ScannedFile> {
        for (index, name) in names.iter().enumerate() {
            fs::write(folder.path().join(name), "x".repeat(index + 1)).unwrap();
        }
        scan_folder(folder.path(), &|_| false).unwrap().files
    }

    fn set_modified(path: &Path, modified: SystemTime) {
        let file = File::options().write(true).open(path).unwrap();
        file.set_modified(modified).unwrap();
    }

    #[test]
    fn all_unchanged_extras_are_moved_in_order() {
        let folder = TempDir::new().unwrap();
        let files = scan_files(&folder, &["a", "b", "c"]);
        let mut fake = FakeTrash::accepting_everything();

        let outcomes = trash_with(&mut fake, &files[0], &files[1..]);

        assert_eq!(outcomes, [Ok(()), Ok(())]);
        assert_eq!(fake.moved, [files[1].path.clone(), files[2].path.clone()]);
    }

    #[test]
    fn refusal_on_one_extra_does_not_stop_the_others() {
        let folder = TempDir::new().unwrap();
        let files = scan_files(&folder, &["a", "b", "c", "d"]);
        let mut fake = FakeTrash::refusing(files[2].path.clone());

        let outcomes = trash_with(&mut fake, &files[0], &files[1..]);

        assert_eq!(outcomes, [Ok(()), Err(TrashFailure::AccessDenied), Ok(())]);
        assert_eq!(fake.moved, [files[1].path.clone(), files[3].path.clone()]);
    }

    #[test]
    fn extra_changed_after_scan_is_not_moved() {
        let folder = TempDir::new().unwrap();
        let files = scan_files(&folder, &["a", "b", "c"]);
        fs::write(&files[1].path, "новое содержимое").unwrap();
        let mut fake = FakeTrash::accepting_everything();

        let outcomes = trash_with(&mut fake, &files[0], &files[1..]);

        assert_eq!(outcomes, [Err(TrashFailure::ChangedSinceScan), Ok(())]);
        assert_eq!(fake.moved, [files[2].path.clone()]);
    }

    #[test]
    fn extra_with_new_modification_time_is_not_moved() {
        let folder = TempDir::new().unwrap();
        let files = scan_files(&folder, &["a", "b"]);
        set_modified(&files[1].path, files[1].modified + ONE_HOUR);
        let mut fake = FakeTrash::accepting_everything();

        let outcomes = trash_with(&mut fake, &files[0], &files[1..]);

        assert_eq!(outcomes, [Err(TrashFailure::ChangedSinceScan)]);
        assert!(fake.moved.is_empty());
    }

    #[test]
    fn extra_removed_after_scan_is_not_moved() {
        let folder = TempDir::new().unwrap();
        let files = scan_files(&folder, &["a", "b", "c"]);
        fs::remove_file(&files[2].path).unwrap();
        let mut fake = FakeTrash::accepting_everything();

        let outcomes = trash_with(&mut fake, &files[0], &files[1..]);

        assert_eq!(outcomes, [Ok(()), Err(TrashFailure::Vanished)]);
        assert_eq!(fake.moved, [files[1].path.clone()]);
    }

    #[test]
    fn kept_file_changed_leaves_the_whole_group_untouched() {
        let folder = TempDir::new().unwrap();
        let files = scan_files(&folder, &["a", "b", "c"]);
        fs::write(&files[0].path, "новое содержимое").unwrap();
        let mut fake = FakeTrash::accepting_everything();

        let outcomes = trash_with(&mut fake, &files[0], &files[1..]);

        assert_eq!(
            outcomes,
            [
                Err(TrashFailure::KeptFileChanged),
                Err(TrashFailure::KeptFileChanged)
            ]
        );
        assert!(fake.moved.is_empty());
    }

    #[test]
    fn kept_file_removed_leaves_the_whole_group_untouched() {
        let folder = TempDir::new().unwrap();
        let files = scan_files(&folder, &["a", "b"]);
        fs::remove_file(&files[0].path).unwrap();
        let mut fake = FakeTrash::accepting_everything();

        let outcomes = trash_with(&mut fake, &files[0], &files[1..]);

        assert_eq!(outcomes, [Err(TrashFailure::KeptFileChanged)]);
        assert!(fake.moved.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn extra_that_is_the_same_file_as_kept_is_not_moved() {
        let folder = TempDir::new().unwrap();
        let files = scan_files(&folder, &["a", "b"]);
        let second_path_to_kept = folder.path().join("link_to_a");
        fs::hard_link(&files[0].path, &second_path_to_kept).unwrap();
        let extra_that_became_kept = ScannedFile {
            path: second_path_to_kept,
            ..files[0].clone()
        };
        let extras = [extra_that_became_kept, files[1].clone()];
        let mut fake = FakeTrash::accepting_everything();

        let outcomes = trash_with(&mut fake, &files[0], &extras);

        assert_eq!(outcomes, [Err(TrashFailure::SameFileAsKept), Ok(())]);
        assert_eq!(fake.moved, [files[1].path.clone()]);
    }

    #[cfg(unix)]
    #[test]
    fn extra_replaced_by_a_link_to_kept_after_scan_is_not_moved() {
        let folder = TempDir::new().unwrap();
        let files = scan_files(&folder, &["a", "b"]);
        fs::remove_file(&files[1].path).unwrap();
        fs::hard_link(&files[0].path, &files[1].path).unwrap();
        let mut fake = FakeTrash::accepting_everything();

        let outcomes = trash_with(&mut fake, &files[0], &files[1..]);

        assert_eq!(outcomes, [Err(TrashFailure::ChangedSinceScan)]);
        assert!(fake.moved.is_empty());
    }

    struct TwoFileGroup {
        kept: ScannedFile,
        extra: ScannedFile,
    }

    impl CleanupGroup for TwoFileGroup {
        fn kept_file(&self) -> &ScannedFile {
            &self.kept
        }

        fn extra_files(&self) -> Vec<&ScannedFile> {
            vec![&self.extra]
        }
    }

    fn group_of(files: &[ScannedFile], kept_index: usize, extra_index: usize) -> TwoFileGroup {
        TwoFileGroup {
            kept: files[kept_index].clone(),
            extra: files[extra_index].clone(),
        }
    }

    #[test]
    fn groups_are_moved_independently_and_summarised() {
        let folder = TempDir::new().unwrap();
        let files = scan_files(&folder, &["a", "b", "c", "d"]);
        fs::write(&files[2].path, "новое содержимое").unwrap();
        let groups = [group_of(&files, 0, 1), group_of(&files, 2, 3)];
        let mut fake = FakeTrash::accepting_everything();

        let outcomes = trash_groups(&groups, &mut |path| fake.move_to_trash(path));

        assert_eq!(
            outcomes,
            [vec![Ok(())], vec![Err(TrashFailure::KeptFileChanged)]]
        );
        assert_eq!(fake.moved, [files[1].path.clone()]);
        assert_eq!(count_extra_files(&groups), 2);
        assert_eq!(
            CleanupSummary::of(&groups, &outcomes),
            CleanupSummary {
                trashed_count: 1,
                trashed_bytes: files[1].size,
                failed_count: 1,
            }
        );
    }

    #[test]
    fn failures_are_described_in_russian() {
        assert_eq!(
            TrashFailure::KeptFileChanged.to_string(),
            "файл, который должен остаться, изменился, пропал или недоступен — группа не тронута"
        );
        assert_eq!(
            TrashFailure::SameFileAsKept.to_string(),
            "это тот же файл, что и оставляемый, — не переносится"
        );
        assert_eq!(
            TrashFailure::ChangedSinceScan.to_string(),
            "файл изменился после проверки"
        );
        assert_eq!(
            TrashFailure::Vanished.to_string(),
            "файл пропал после проверки"
        );
        assert_eq!(
            TrashFailure::AccessDenied.to_string(),
            "нет прав, чтобы перенести файл"
        );
        assert_eq!(
            TrashFailure::Unexpected("сбой диска".to_string()).to_string(),
            "непредвиденная ошибка (системное сообщение: сбой диска)"
        );
    }

    #[test]
    fn failures_have_stable_codes() {
        assert_eq!(TrashFailure::KeptFileChanged.code(), "kept_file_changed");
        assert_eq!(TrashFailure::SameFileAsKept.code(), "same_file_as_kept");
        assert_eq!(TrashFailure::ChangedSinceScan.code(), "changed_since_scan");
        assert_eq!(TrashFailure::Vanished.code(), "vanished");
        assert_eq!(TrashFailure::AccessDenied.code(), "access_denied");
        assert_eq!(TrashFailure::Unexpected(String::new()).code(), "unexpected");
    }

    #[test]
    fn io_errors_become_matching_failures() {
        let denied = io::Error::from(io::ErrorKind::PermissionDenied);
        let missing = io::Error::from(io::ErrorKind::NotFound);
        let other = io::Error::other("сбой диска");

        assert_eq!(TrashFailure::from(&denied), TrashFailure::AccessDenied);
        assert_eq!(TrashFailure::from(&missing), TrashFailure::Vanished);
        assert_eq!(
            TrashFailure::from(&other),
            TrashFailure::Unexpected("сбой диска".to_string())
        );
    }
}
