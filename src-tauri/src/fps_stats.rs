use std::collections::VecDeque;

pub const WINDOW_SECS: f64 = 10.0;

fn csv_column(line: &str, column: usize) -> Option<&str> {
    let mut start = 0;
    let mut current = 0;
    let mut quoted = false;
    for (index, byte) in line.bytes().enumerate() {
        match byte {
            b'"' => quoted = !quoted,
            b',' if !quoted => {
                if current == column {
                    return Some(line[start..index].trim().trim_matches('"'));
                }
                start = index + 1;
                current += 1;
            }
            _ => {}
        }
    }
    (current == column).then(|| line[start..].trim().trim_matches('"'))
}

pub fn header_column(header: &str) -> Option<usize> {
    let header = header.trim_start_matches('\u{feff}');
    let mut fallback = None;
    let mut column = 0;
    while let Some(name) = csv_column(header, column) {
        if name == "MsBetweenPresents" {
            return Some(column);
        }
        if name == "FrameTime" {
            fallback = Some(column);
        }
        column += 1;
    }
    fallback
}

pub fn parse_frametime(line: &str, col: usize) -> Option<f64> {
    if line.starts_with("Application,") {
        return None;
    }
    let value = csv_column(line, col)?.parse::<f64>().ok()?;
    (value.is_finite() && value > 0.0).then_some(value)
}

#[derive(Default)]
pub struct RollingFrames {
    frames: VecDeque<f64>,
    sum_ms: f64,
}

impl RollingFrames {
    pub fn push(&mut self, frametime_ms: f64) {
        if !frametime_ms.is_finite() || frametime_ms <= 0.0 {
            return;
        }
        self.frames.push_back(frametime_ms);
        self.sum_ms += frametime_ms;
        while self.sum_ms > WINDOW_SECS * 1000.0 && self.frames.len() > 1 {
            self.sum_ms -= self.frames.pop_front().unwrap_or_default();
        }
    }

    pub fn stats(&self) -> Option<(f64, f64, f64)> {
        let count = self.frames.len();
        if count == 0 {
            return None;
        }
        let avg = 1000.0 * count as f64 / self.sum_ms;
        let mut sorted: Vec<_> = self.frames.iter().copied().collect();
        sorted.sort_by(|a, b| b.total_cmp(a));
        let worst_count = count.div_ceil(100);
        let low1 = 1000.0 * worst_count as f64 / sorted[..worst_count].iter().sum::<f64>();

        let mut last_ms = 0.0;
        let mut last_count = 0;
        for frametime in self.frames.iter().rev() {
            last_ms += frametime;
            last_count += 1;
            if last_ms >= 1000.0 {
                break;
            }
        }
        Some((avg, low1, last_ms / last_count as f64))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_frames() {
        let mut frames = RollingFrames::default();
        for _ in 0..1000 {
            frames.push(10.0);
        }
        assert_eq!(frames.stats(), Some((100.0, 100.0, 10.0)));
    }

    #[test]
    fn worst_one_percent() {
        let mut frames = RollingFrames::default();
        for _ in 0..99 {
            frames.push(10.0);
        }
        frames.push(100.0);
        let (_, low1, frametime) = frames.stats().unwrap();
        assert_eq!(low1, 10.0);
        assert_eq!(frametime, 1000.0 / 91.0);
    }

    #[test]
    fn trims_old_frames() {
        let mut frames = RollingFrames::default();
        frames.push(100.0);
        for _ in 0..1000 {
            frames.push(10.0);
        }
        assert_eq!(frames.stats(), Some((100.0, 100.0, 10.0)));
    }

    #[test]
    fn finds_both_header_names_and_skips_invalid_rows() {
        assert_eq!(header_column("Application,MsBetweenPresents,FrameTime"), Some(1));
        assert_eq!(header_column("Application,FrameTime"), Some(1));
        assert_eq!(header_column("Application,Other"), None);
        assert_eq!(parse_frametime("game.exe,10", 1), Some(10.0));
        assert_eq!(parse_frametime("\"game, one.exe\",10", 1), Some(10.0));
        assert_eq!(parse_frametime("Application,FrameTime", 1), None);
        assert_eq!(parse_frametime("game.exe,NaN", 1), None);
        assert_eq!(parse_frametime("game.exe,0", 1), None);
    }
}
