mod cli;
mod duplicates;
mod perceptual_hash;
mod photo;
mod report;
mod scan;
mod similar;
mod skipped;
#[cfg(test)]
mod test_images;

use std::path::Path;
use std::process::ExitCode;

use clap::Parser;
use clap::error::ErrorKind;

use cli::{Cli, SearchMode, argument_error_message};
use duplicates::find_duplicates;
use report::{format_duplicates_report, format_similar_report, format_skipped};
use scan::{FolderError, scan_folder};
use similar::find_similar_photos;
use skipped::SkippedPath;

const FOLDER_ERROR_EXIT_CODE: u8 = 1;
const ARGUMENTS_ERROR_EXIT_CODE: u8 = 2;

fn main() -> ExitCode {
    match Cli::try_parse() {
        Ok(cli) => match cli.search_mode() {
            SearchMode::ExactDuplicates => report_duplicates(&cli.folder),
            SearchMode::SimilarPhotos { similarity_percent } => {
                report_similar_photos(&cli.folder, similarity_percent)
            }
        },
        Err(err) => report_argument_error(&err),
    }
}

fn report_argument_error(err: &clap::Error) -> ExitCode {
    if err.kind() == ErrorKind::DisplayHelp {
        err.exit();
    }

    eprintln!("{}", argument_error_message(err));
    ExitCode::from(ARGUMENTS_ERROR_EXIT_CODE)
}

fn report_duplicates(folder: &Path) -> ExitCode {
    let scan = match scan_folder(folder) {
        Ok(scan) => scan,
        Err(err) => return report_folder_error(&err),
    };

    let search = find_duplicates(scan.files);

    print_skipped(&scan.skipped, &search.skipped);
    println!("{}", format_duplicates_report(&search));

    ExitCode::SUCCESS
}

fn report_similar_photos(folder: &Path, similarity_percent: u8) -> ExitCode {
    let scan = match scan_folder(folder) {
        Ok(scan) => scan,
        Err(err) => return report_folder_error(&err),
    };

    let search = find_similar_photos(scan.files, similarity_percent);

    print_skipped(&scan.skipped, &search.skipped);
    println!("{}", format_similar_report(&search));

    ExitCode::SUCCESS
}

fn report_folder_error(err: &FolderError) -> ExitCode {
    eprintln!("{err}");
    ExitCode::from(FOLDER_ERROR_EXIT_CODE)
}

fn print_skipped(skipped_by_scan: &[SkippedPath], skipped_by_search: &[SkippedPath]) {
    for skipped in skipped_by_scan.iter().chain(skipped_by_search) {
        eprintln!("{}", format_skipped(skipped));
    }
}
