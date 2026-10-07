mod cli;
mod duplicates;
mod report;
mod scan;
mod skipped;

use std::path::Path;
use std::process::ExitCode;

use clap::Parser;
use clap::error::ErrorKind;

use cli::{Cli, argument_error_message};
use duplicates::find_duplicates;
use report::{format_report, format_skipped};
use scan::scan_folder;

const FOLDER_ERROR_EXIT_CODE: u8 = 1;
const ARGUMENTS_ERROR_EXIT_CODE: u8 = 2;

fn main() -> ExitCode {
    match Cli::try_parse() {
        Ok(cli) => report_duplicates(&cli.folder),
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
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::from(FOLDER_ERROR_EXIT_CODE);
        }
    };

    let search = find_duplicates(scan.files);

    for skipped in scan.skipped.iter().chain(&search.skipped) {
        eprintln!("{}", format_skipped(skipped));
    }
    println!("{}", format_report(&search));

    ExitCode::SUCCESS
}
