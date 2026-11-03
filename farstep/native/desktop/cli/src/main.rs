#[tokio::main]
async fn main() -> std::process::ExitCode {
    match farstep_desktop::run().await {
        Ok(status) => std::process::ExitCode::from(status as u8),
        Err(error) => {
            eprintln!("{}: {}", error.code, error.message);
            std::process::ExitCode::FAILURE
        }
    }
}
