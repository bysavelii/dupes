//! Отчёт для скриптов: ключи всегда на месте, а неприменимые к запуску значения — `null`.

use serde::Serialize;

use crate::cleanup::{Cleanup, CleanupGroup, CleanupSummary, ExtraStatus, TrashFailure};
use crate::duplicates::{DuplicateGroup, DuplicateSearch};
use crate::scan::ScannedFile;
use crate::similar::{SimilarGroup, SimilarPhoto, SimilarSearch};
use crate::skipped::SkippedPath;

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Duplicates,
    SimilarPhotos,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum ActionName {
    Report,
    DryRun,
    Trash,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum StatusName {
    Trashed,
    Failed,
}

#[derive(Serialize)]
struct JsonFile {
    path: String,
    size: u64,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Serialize)]
struct JsonError {
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
struct JsonExtra {
    #[serde(flatten)]
    file: JsonFile,
    status: Option<StatusName>,
    error: Option<JsonError>,
}

#[derive(Serialize)]
struct JsonGroup {
    keep: JsonFile,
    extras: Vec<JsonExtra>,
}

#[derive(Serialize)]
struct JsonSkipped {
    path: String,
    reason: &'static str,
    message: String,
}

#[derive(Serialize)]
struct JsonReport {
    mode: Mode,
    similarity_percent: Option<u8>,
    action: ActionName,
    groups: Vec<JsonGroup>,
    reclaimable_bytes: u64,
    trashed_count: Option<usize>,
    trashed_bytes: Option<u64>,
    failed_count: Option<usize>,
    skipped: Vec<JsonSkipped>,
}

/// Поля отчёта, которые зависят от того, что искали.
struct ReportHeader {
    mode: Mode,
    similarity_percent: Option<u8>,
    reclaimable_bytes: u64,
}

/// Файл и, у фото, его размеры в пикселях.
struct FileView<'a> {
    file: &'a ScannedFile,
    dimensions: Option<(u32, u32)>,
}

impl FileView<'_> {
    fn to_json(&self) -> JsonFile {
        JsonFile {
            path: self.file.path.to_string_lossy().into_owned(),
            size: self.file.size,
            width: self.dimensions.map(|(width, _)| width),
            height: self.dimensions.map(|(_, height)| height),
        }
    }
}

struct GroupView<'a> {
    kept: FileView<'a>,
    extras: Vec<FileView<'a>>,
}

pub fn duplicates_json<'a>(
    search: &DuplicateSearch,
    cleanup: &Cleanup,
    skipped: impl IntoIterator<Item = &'a SkippedPath>,
) -> String {
    let header = ReportHeader {
        mode: Mode::Duplicates,
        similarity_percent: None,
        reclaimable_bytes: search.reclaimable_bytes(),
    };
    let views = search.groups.iter().map(duplicate_group_view).collect();

    render(&build_report(
        header,
        &search.groups,
        views,
        cleanup,
        skipped,
    ))
}

pub fn similar_json<'a>(
    search: &SimilarSearch,
    similarity_percent: u8,
    cleanup: &Cleanup,
    skipped: impl IntoIterator<Item = &'a SkippedPath>,
) -> String {
    let header = ReportHeader {
        mode: Mode::SimilarPhotos,
        similarity_percent: Some(similarity_percent),
        reclaimable_bytes: search.reclaimable_bytes(),
    };
    let views = search.groups.iter().map(similar_group_view).collect();

    render(&build_report(
        header,
        &search.groups,
        views,
        cleanup,
        skipped,
    ))
}

fn duplicate_group_view(group: &DuplicateGroup) -> GroupView<'_> {
    GroupView {
        kept: file_view(&group.kept),
        extras: group.copies.iter().map(file_view).collect(),
    }
}

fn similar_group_view(group: &SimilarGroup) -> GroupView<'_> {
    GroupView {
        kept: photo_view(&group.best),
        extras: group.others.iter().map(photo_view).collect(),
    }
}

fn file_view(file: &ScannedFile) -> FileView<'_> {
    FileView {
        file,
        dimensions: None,
    }
}

fn photo_view(photo: &SimilarPhoto) -> FileView<'_> {
    FileView {
        file: &photo.file,
        dimensions: Some((photo.width, photo.height)),
    }
}

fn build_report<'a, Group: CleanupGroup>(
    header: ReportHeader,
    search_groups: &[Group],
    group_views: Vec<GroupView>,
    cleanup: &Cleanup,
    skipped: impl IntoIterator<Item = &'a SkippedPath>,
) -> JsonReport {
    let summary = match cleanup {
        Cleanup::Done(outcomes_by_group) => {
            Some(CleanupSummary::of(search_groups, outcomes_by_group))
        }
        Cleanup::ReportOnly | Cleanup::Preview => None,
    };
    let groups = group_views
        .iter()
        .enumerate()
        .map(|(index, group)| json_group(index, group, cleanup))
        .collect();

    JsonReport {
        mode: header.mode,
        similarity_percent: header.similarity_percent,
        action: action_name(cleanup),
        groups,
        reclaimable_bytes: header.reclaimable_bytes,
        trashed_count: summary.as_ref().map(|summary| summary.trashed_count),
        trashed_bytes: summary.as_ref().map(|summary| summary.trashed_bytes),
        failed_count: summary.as_ref().map(|summary| summary.failed_count),
        skipped: skipped.into_iter().map(json_skipped).collect(),
    }
}

fn action_name(cleanup: &Cleanup) -> ActionName {
    match cleanup {
        Cleanup::ReportOnly => ActionName::Report,
        Cleanup::Preview => ActionName::DryRun,
        Cleanup::Done(_) => ActionName::Trash,
    }
}

fn json_group(group_index: usize, group: &GroupView, cleanup: &Cleanup) -> JsonGroup {
    let extras = group
        .extras
        .iter()
        .enumerate()
        .map(|(extra_index, extra)| {
            json_extra(extra, cleanup.extra_status(group_index, extra_index))
        })
        .collect();

    JsonGroup {
        keep: group.kept.to_json(),
        extras,
    }
}

fn json_extra(extra: &FileView, status: ExtraStatus) -> JsonExtra {
    let file = extra.to_json();
    match status {
        ExtraStatus::Listed | ExtraStatus::WillBeTrashed => JsonExtra {
            file,
            status: None,
            error: None,
        },
        ExtraStatus::Trashed => JsonExtra {
            file,
            status: Some(StatusName::Trashed),
            error: None,
        },
        ExtraStatus::NotTrashed(failure) => JsonExtra {
            file,
            status: Some(StatusName::Failed),
            error: Some(json_error(failure)),
        },
    }
}

fn json_error(failure: &TrashFailure) -> JsonError {
    JsonError {
        code: failure.code(),
        message: failure.to_string(),
    }
}

fn json_skipped(skipped: &SkippedPath) -> JsonSkipped {
    JsonSkipped {
        path: skipped.path.to_string_lossy().into_owned(),
        reason: skipped.reason.code(),
        message: skipped.reason.to_string(),
    }
}

fn render(report: &JsonReport) -> String {
    serde_json::to_string_pretty(report)
        .expect("отчёт состоит из строк и чисел, поэтому записать его в JSON всегда удаётся")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cleanup::TrashOutcome;
    use crate::skipped::SkipReason;
    use serde_json::{Value, json};
    use std::time::SystemTime;

    fn scanned(path: &str, size: u64) -> ScannedFile {
        ScannedFile {
            path: path.into(),
            size,
            modified: SystemTime::UNIX_EPOCH,
            identity: None,
        }
    }

    fn duplicate_search() -> DuplicateSearch {
        DuplicateSearch {
            groups: vec![DuplicateGroup {
                kept: scanned("a.txt", 100),
                copies: vec![scanned("b.txt", 100), scanned("c.txt", 100)],
            }],
            skipped: Vec::new(),
        }
    }

    fn similar_search() -> SimilarSearch {
        SimilarSearch {
            groups: vec![SimilarGroup {
                best: SimilarPhoto {
                    file: scanned("big.png", 5000),
                    width: 640,
                    height: 480,
                },
                others: vec![SimilarPhoto {
                    file: scanned("small.jpg", 800),
                    width: 160,
                    height: 120,
                }],
            }],
            skipped: Vec::new(),
        }
    }

    fn parse(json: &str) -> Value {
        serde_json::from_str(json).unwrap()
    }

    fn no_skipped() -> Vec<SkippedPath> {
        Vec::new()
    }

    #[test]
    fn report_only_has_every_key_and_nulls_for_cleanup() {
        let json = duplicates_json(&duplicate_search(), &Cleanup::ReportOnly, &no_skipped());

        assert_eq!(
            parse(&json),
            json!({
                "mode": "duplicates",
                "similarity_percent": null,
                "action": "report",
                "groups": [{
                    "keep": {"path": "a.txt", "size": 100, "width": null, "height": null},
                    "extras": [
                        {"path": "b.txt", "size": 100, "width": null, "height": null,
                         "status": null, "error": null},
                        {"path": "c.txt", "size": 100, "width": null, "height": null,
                         "status": null, "error": null},
                    ],
                }],
                "reclaimable_bytes": 200,
                "trashed_count": null,
                "trashed_bytes": null,
                "failed_count": null,
                "skipped": [],
            })
        );
    }

    #[test]
    fn preview_is_a_dry_run_without_statuses() {
        let json = duplicates_json(&duplicate_search(), &Cleanup::Preview, &no_skipped());

        let report = parse(&json);
        assert_eq!(report["action"], "dry_run");
        assert_eq!(report["groups"][0]["extras"][0]["status"], Value::Null);
        assert_eq!(report["trashed_count"], Value::Null);
    }

    #[test]
    fn done_report_has_statuses_errors_and_totals() {
        let outcomes: Vec<Vec<TrashOutcome>> = vec![vec![Ok(()), Err(TrashFailure::Vanished)]];

        let json = duplicates_json(
            &duplicate_search(),
            &Cleanup::Done(&outcomes),
            &no_skipped(),
        );

        let report = parse(&json);
        assert_eq!(report["action"], "trash");
        assert_eq!(report["trashed_count"], 1);
        assert_eq!(report["trashed_bytes"], 100);
        assert_eq!(report["failed_count"], 1);
        let extras = &report["groups"][0]["extras"];
        assert_eq!(extras[0]["status"], "trashed");
        assert_eq!(extras[0]["error"], Value::Null);
        assert_eq!(extras[1]["status"], "failed");
        assert_eq!(
            extras[1]["error"],
            json!({"code": "vanished", "message": "файл пропал после проверки"})
        );
    }

    #[test]
    fn similar_report_has_dimensions_and_similarity() {
        let json = similar_json(&similar_search(), 85, &Cleanup::ReportOnly, &no_skipped());

        let report = parse(&json);
        assert_eq!(report["mode"], "similar_photos");
        assert_eq!(report["similarity_percent"], 85);
        assert_eq!(report["reclaimable_bytes"], 800);
        assert_eq!(
            report["groups"][0]["keep"],
            json!({"path": "big.png", "size": 5000, "width": 640, "height": 480})
        );
        assert_eq!(report["groups"][0]["extras"][0]["width"], 160);
        assert_eq!(report["groups"][0]["extras"][0]["height"], 120);
    }

    #[test]
    fn skipped_paths_have_stable_code_and_russian_message() {
        let skipped = vec![SkippedPath {
            path: "secret.txt".into(),
            reason: SkipReason::AccessDenied,
        }];

        let json = duplicates_json(&duplicate_search(), &Cleanup::ReportOnly, &skipped);

        assert_eq!(
            parse(&json)["skipped"],
            json!([{
                "path": "secret.txt",
                "reason": "access_denied",
                "message": "нет прав на чтение",
            }])
        );
    }

    #[test]
    fn search_without_groups_has_empty_groups_and_zero_space() {
        let search = DuplicateSearch {
            groups: Vec::new(),
            skipped: Vec::new(),
        };

        let report = parse(&duplicates_json(
            &search,
            &Cleanup::ReportOnly,
            &no_skipped(),
        ));

        assert_eq!(report["groups"], json!([]));
        assert_eq!(report["reclaimable_bytes"], 0);
    }

    #[cfg(unix)]
    #[test]
    fn path_that_is_not_utf8_is_written_lossily() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let mut search = duplicate_search();
        search.groups[0].kept.path = OsString::from_vec(b"bad\xFF.txt".to_vec()).into();

        let report = parse(&duplicates_json(
            &search,
            &Cleanup::ReportOnly,
            &no_skipped(),
        ));

        assert_eq!(report["groups"][0]["keep"]["path"], "bad\u{FFFD}.txt");
    }
}
