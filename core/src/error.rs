use std::fmt;

#[derive(Debug)]
pub enum CoreError {
    Decode(String),
    Io(std::io::Error),
    UnsupportedFormat(String),
    InvalidParam(String),
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreError::Decode(s) => write!(f, "decode error: {s}"),
            CoreError::Io(e) => write!(f, "io error: {e}"),
            CoreError::UnsupportedFormat(s) => write!(f, "unsupported format: {s}"),
            CoreError::InvalidParam(s) => write!(f, "invalid parameter: {s}"),
        }
    }
}

impl std::error::Error for CoreError {}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self {
        CoreError::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, CoreError>;
