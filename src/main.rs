mod cleanup;
mod cli;
mod duplicates;
mod json_report;
mod perceptual_hash;
mod photo;
mod report;
mod scan;
mod similar;
mod skipped;
mod system_trash;
#[cfg(test)]
mod test_images;

use std::process::ExitCode;

use clap::Parser;
use clap::error::ErrorKind;

use cleanup::{Cleanup, CleanupGroup, TrashOutcome, trash_groups};
use cli::{Action, Cli, OutputFormat, SearchMode, argument_error_message};
use duplicates::{DuplicateSearch, find_duplicates};
use json_report::{duplicates_json, similar_json};
use report::{format_duplicates_report, format_similar_report, format_skipped};
use scan::{FolderError, FolderScan, scan_folder};
use similar::{SimilarSearch, find_similar_photos};
use skipped::SkippedPath;
use system_trash::{is_trash_folder, move_to_system_trash};

const FOLDER_ERROR_EXIT_CODE: u8 = 1;
const ARGUMENTS_ERROR_EXIT_CODE: u8 = 2;
const TRASH_FAILURE_EXIT_CODE: u8 = 3;

fn main() -> ExitCode {
    match Cli::try_parse() {
        Ok(cli) => run(&cli),
        Err(err) => report_argument_error(&err),
    }
}

fn report_argument_error(err: &clap::Error) -> ExitCode {
    if matches!(
        err.kind(),
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
    ) {
        err.exit();
    }

    eprintln!("{}", argument_error_message(err));
    ExitCode::from(ARGUMENTS_ERROR_EXIT_CODE)
}

fn run(cli: &Cli) -> ExitCode {
    let scan = match scan_folder(&cli.folder, &is_trash_folder) {
        Ok(scan) => scan,
        Err(err) => return report_folder_error(&err),
    };

    match cli.search_mode() {
        SearchMode::ExactDuplicates => run_duplicates(scan, cli),
        SearchMode::SimilarPhotos { similarity_percent } => {
            run_similar_photos(scan, similarity_percent, cli)
        }
    }
}

fn run_duplicates(scan: FolderScan, cli: &Cli) -> ExitCode {
    let search = find_duplicates(scan.files);
    let outcomes = trash_if_confirmed(&search.groups, cli.action());
    let cleanup = cleanup_of(cli.action(), &outcomes);

    print_duplicates(&search, &scan.skipped, &cleanup, cli.output_format());

    exit_code_after(&outcomes)
}

fn run_similar_photos(scan: FolderScan, similarity_percent: u8, cli: &Cli) -> ExitCode {
    let search = find_similar_photos(scan.files, similarity_percent);
    let outcomes = trash_if_confirmed(&search.groups, cli.action());
    let cleanup = cleanup_of(cli.action(), &outcomes);

    print_similar_photos(
        &search,
        similarity_percent,
        &scan.skipped,
        &cleanup,
        cli.output_format(),
    );

    exit_code_after(&outcomes)
}

fn report_folder_error(err: &FolderError) -> ExitCode {
    eprintln!("{err}");
    ExitCode::from(FOLDER_ERROR_EXIT_CODE)
}

/// Результаты переноса по группам; пустые, если переносить не просили.
fn trash_if_confirmed<Group: CleanupGroup>(
    groups: &[Group],
    action: Action,
) -> Vec<Vec<TrashOutcome>> {
    match action {
        Action::MoveToTrash => trash_groups(groups, &mut move_to_system_trash),
        Action::Report | Action::DryRun => Vec::new(),
    }
}

fn cleanup_of(action: Action, outcomes: &[Vec<TrashOutcome>]) -> Cleanup<'_> {
    match action {
        Action::Report => Cleanup::ReportOnly,
        Action::DryRun => Cleanup::Preview,
        Action::MoveToTrash => Cleanup::Done(outcomes),
    }
}

fn exit_code_after(outcomes: &[Vec<TrashOutcome>]) -> ExitCode {
    let has_failure = outcomes.iter().flatten().any(Result::is_err);
    if has_failure {
        return ExitCode::from(TRASH_FAILURE_EXIT_CODE);
    }

    ExitCode::SUCCESS
}

fn print_duplicates(
    search: &DuplicateSearch,
    skipped_by_scan: &[SkippedPath],
    cleanup: &Cleanup,
    output_format: OutputFormat,
) {
    match output_format {
        OutputFormat::Text => {
            print_skipped(skipped_by_scan, &search.skipped);
            println!("{}", format_duplicates_report(search, cleanup));
        }
        OutputFormat::Json => {
            let skipped = skipped_by_scan.iter().chain(&search.skipped);
            println!("{}", duplicates_json(search, cleanup, skipped));
        }
    }
}

fn print_similar_photos(
    search: &SimilarSearch,
    similarity_percent: u8,
    skipped_by_scan: &[SkippedPath],
    cleanup: &Cleanup,
    output_format: OutputFormat,
) {
    match output_format {
        OutputFormat::Text => {
            print_skipped(skipped_by_scan, &search.skipped);
            println!("{}", format_similar_report(search, cleanup));
        }
        OutputFormat::Json => {
            let skipped = skipped_by_scan.iter().chain(&search.skipped);
            println!(
                "{}",
                similar_json(search, similarity_percent, cleanup, skipped)
            );
        }
    }
}

fn print_skipped(skipped_by_scan: &[SkippedPath], skipped_by_search: &[SkippedPath]) {
    for skipped in skipped_by_scan.iter().chain(skipped_by_search) {
        eprintln!("{}", format_skipped(skipped));
    }
}
