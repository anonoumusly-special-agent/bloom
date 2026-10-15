pub fn to_mono(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels == 0 {
        return Vec::new();
    }
    samples
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

pub fn resample_linear(input: &[f32], from_hz: u32, to_hz: u32) -> Vec<f32> {
    if from_hz == 0 || to_hz == 0 {
        return Vec::new();
    }
    if from_hz == to_hz {
        return input.to_vec();
    }
    let len = usize::try_from((input.len() as u128 * to_hz as u128).div_ceil(from_hz as u128))
        .expect("resampled audio too large");
    (0..len)
        .map(|i| {
            let position = i as f64 * f64::from(from_hz) / f64::from(to_hz);
            let left = position.floor() as usize;
            let fraction = (position - left as f64) as f32;
            let a = input[left.min(input.len() - 1)];
            let b = input[(left + 1).min(input.len() - 1)];
            a + (b - a) * fraction
        })
        .collect()
}

pub fn encode_wav_16k_mono(samples: &[f32]) -> Vec<u8> {
    let data_len = u32::try_from(samples.len().checked_mul(2).expect("WAV data too large"))
        .expect("WAV data too large");
    let riff_len = data_len.checked_add(36).expect("WAV data too large");
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_len.to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&16_000u32.to_le_bytes());
    wav.extend_from_slice(&32_000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for &sample in samples {
        wav.extend_from_slice(&((sample.clamp(-1.0, 1.0) * 32_768.0).round() as i16).to_le_bytes());
    }
    wav
}

pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples
        .iter()
        .map(|&sample| f64::from(sample) * f64::from(sample))
        .sum::<f64>()
        / samples.len() as f64)
        .sqrt() as f32
}

pub fn has_speech(samples_16k: &[f32], threshold: f32) -> bool {
    samples_16k
        .chunks_exact(320)
        .filter(|window| rms(window) >= threshold)
        .take(15)
        .count()
        == 15
}

pub fn last_silence_cut(samples_16k: &[f32], threshold: f32) -> Option<usize> {
    samples_16k
        .chunks_exact(320)
        .enumerate()
        .filter(|(window, samples)| {
            window * 320 >= samples_16k.len() / 2 && rms(samples) < threshold
        })
        .map(|(window, _)| window * 320)
        .last()
}

pub fn build_prompt(words: &str, max_chars: usize) -> String {
    let mut prompt = String::new();
    let mut used = 0;
    for word in words.lines().map(str::trim).filter(|word| !word.is_empty()) {
        let extra = word.chars().count() + if prompt.is_empty() { 0 } else { 2 };
        if extra > max_chars.saturating_sub(used) {
            break;
        }
        if !prompt.is_empty() {
            prompt.push_str(", ");
        }
        prompt.push_str(word);
        used += extra;
    }
    prompt
}

pub fn parse_replacements(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let (from, to) = line.split_once("=>")?;
            let (from, to) = (from.trim(), to.trim());
            (!from.is_empty() && !to.is_empty() && !to.contains("=>"))
                .then(|| (from.to_string(), to.to_string()))
        })
        .collect()
}

pub fn apply_replacements(text: &str, reps: &[(String, String)]) -> String {
    let mut result = String::with_capacity(text.len());
    let mut index = 0;
    // ponytail: Scan each rule at each character; use a matcher if word lists grow large.
    while index < text.len() {
        let rest = &text[index..];
        let before_word = text[..index]
            .chars()
            .next_back()
            .is_none_or(|ch| !ch.is_alphanumeric());
        let replacement = reps.iter().find_map(|(from, to)| {
            if from.is_empty() || !before_word {
                return None;
            }
            let mut chars = rest.char_indices();
            for expected in from.chars() {
                let (_, actual) = chars.next()?;
                if !actual.to_lowercase().eq(expected.to_lowercase()) {
                    return None;
                }
            }
            let end = chars.next().map_or(rest.len(), |(offset, _)| offset);
            rest[end..]
                .chars()
                .next()
                .is_none_or(|ch| !ch.is_alphanumeric())
                .then_some((end, to))
        });
        if let Some((len, to)) = replacement {
            result.push_str(to);
            index += len;
        } else {
            let ch = rest.chars().next().expect("index inside text");
            result.push(ch);
            index += ch.len_utf8();
        }
    }
    result
}

pub fn clean_transcript(text: &str) -> String {
    let mut cleaned = String::with_capacity(text.len());
    let mut index = 0;
    let mut brackets = 0usize;
    while index < text.len() {
        let rest = &text[index..];
        let ch = rest.chars().next().expect("index inside text");
        if ch == '[' {
            brackets += 1;
            if brackets == 1 {
                cleaned.push(' ');
            }
        } else if ch == ']' && brackets > 0 {
            brackets -= 1;
        } else if brackets == 0 {
            if rest.get(..7).is_some_and(|marker| marker.eq_ignore_ascii_case("(Musik)")) {
                cleaned.push(' ');
                index += 7;
                continue;
            }
            cleaned.push(ch);
        }
        index += ch.len_utf8();
    }
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_averages_interleaved_channels() {
        assert_eq!(to_mono(&[1.0, -1.0, 0.5, 0.0], 2), [0.0, 0.25]);
        assert!(to_mono(&[1.0], 0).is_empty());
    }

    #[test]
    fn resampling_interpolates_and_changes_length() {
        assert_eq!(resample_linear(&[0.0, 1.0], 2, 4), [0.0, 0.5, 1.0, 1.0]);
        assert_eq!(resample_linear(&vec![0.0; 480], 48_000, 16_000).len(), 160);
        assert_eq!(resample_linear(&[1.0, 2.0], 16_000, 16_000), [1.0, 2.0]);
    }

    #[test]
    fn wav_has_pcm_header_and_clamped_samples() {
        let wav = encode_wav_16k_mono(&[-2.0, 0.0, 2.0]);
        assert_eq!(wav.len(), 44 + 2 * 3);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(&wav[44..], &[0, 128, 0, 0, 255, 127]);
    }

    #[test]
    fn rms_measures_signal_energy() {
        assert_eq!(rms(&[]), 0.0);
        assert!((rms(&[1.0, -1.0, 0.0, 0.0]) - 0.5f32.sqrt()).abs() < 1e-6);
    }

    #[test]
    fn speech_requires_300_ms_of_active_windows() {
        let mut samples = vec![0.0; 320 * 20];
        assert!(!has_speech(&samples, 0.1));
        for (i, sample) in samples.iter_mut().take(320 * 15).enumerate() {
            *sample = (i as f32 * std::f32::consts::TAU / 40.0).sin();
        }
        assert!(has_speech(&samples, 0.1));
        assert!(!has_speech(&samples[..320 * 14], 0.1));
    }

    #[test]
    fn silence_cut_uses_last_window_in_second_half() {
        let mut samples = vec![1.0; 320 * 10];
        samples[320 * 2..320 * 3].fill(0.0);
        samples[320 * 6..320 * 7].fill(0.0);
        samples[320 * 8..320 * 9].fill(0.0);
        assert_eq!(last_silence_cut(&samples, 0.1), Some(320 * 8));
        assert_eq!(last_silence_cut(&vec![1.0; 320 * 10], 0.1), None);
    }

    #[test]
    fn prompt_counts_unicode_chars_without_splitting_words() {
        assert_eq!(build_prompt("  Äpfel  \n\n Öl\nBirne", 9), "Äpfel, Öl");
        assert_eq!(build_prompt("Äpfel\nÖl", 4), "");
    }

    #[test]
    fn replacements_parser_discards_incomplete_lines() {
        assert_eq!(
            parse_replacements(" bluhm => Bloom \ninvalid\n => x\ny =>  \na => b => c\n New York => NYC "),
            [("bluhm".into(), "Bloom".into()), ("New York".into(), "NYC".into())]
        );
    }

    #[test]
    fn replacements_match_whole_words_and_phrases() {
        let reps = parse_replacements("bluhm => Bloom\nnew york => NYC\nüber => gut");
        assert_eq!(
            apply_replacements("Bluhm, xBluhm Bluhmen; NEW YORK und ÜBER übermäßig", &reps),
            "Bloom, xBluhm Bluhmen; NYC und gut übermäßig"
        );
    }

    #[test]
    fn transcript_removes_markers_and_collapses_space() {
        assert_eq!(
            clean_transcript("  Hallo   [BLANK_AUDIO] (Musik) [Musik]  schöne\nWelt  "),
            "Hallo schöne Welt"
        );
    }
}
