//! Bounded terminal replay for workbench sessions.
//!
//! A view that mounts after a session started (first visit to the workbench, a
//! WebView reload, a host switch) rebuilds its screen from this buffer. Keeping
//! only the newest bytes is not enough: the bytes that fall off the front can
//! carry terminal modes the remaining stream depends on. A full-screen CLI such
//! as Pi enters the alternate screen once (`CSI ? 1049 h`) and then repaints it
//! for hours. Replaying the tail without that switch paints every frame into the
//! normal buffer, where each repaint scrolls into history and the scrollback
//! turns into overlapping fragments. The buffer therefore tracks the modes that
//! were active where the retained bytes start and restores them first.
//!
//! Each chunk also gets a stream offset. A view can then drop the part of a live
//! event that the replay already contained instead of guessing from byte prefixes.

use std::collections::VecDeque;

/// DEC private modes that change how later output is interpreted or how input is
/// encoded. Each entry is `(mode, default_enabled)`.
const TRACKED_MODES: &[(u16, bool)] = &[
    (1, false),    // application cursor keys
    (7, true),     // autowrap
    (25, true),    // cursor visible
    (1000, false), // mouse: button reports
    (1002, false), // mouse: button motion
    (1003, false), // mouse: any motion
    (1004, false), // focus reports
    (1005, false), // mouse: UTF-8 coordinates
    (1006, false), // mouse: SGR coordinates
    (1015, false), // mouse: urxvt coordinates
    (2004, false), // bracketed paste
];

/// Alternate-screen variants. Only one screen is active; the latest switch wins.
const ALT_SCREEN_MODES: &[u16] = &[47, 1047, 1049];

/// Bytes a single escape string may take before the parser gives up on it while
/// looking for a clean replay start. Inline images can be large; this only bounds
/// how far the start moves, never what the buffer keeps.
const MAX_BOUNDARY_SKIP: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ParseState {
    Ground,
    Escape,
    /// `ESC` followed by intermediates such as `(` or `#`; one final byte ends it.
    EscapeIntermediate,
    Csi,
    /// OSC, DCS, SOS, PM and APC strings end with BEL or `ESC \`.
    String,
    StringEscape,
}

/// Incremental VT parser that only records mode switches.
#[derive(Clone, Debug)]
pub struct ModeTracker {
    state: ParseState,
    params: Vec<u8>,
    private: bool,
    modes: Vec<(u16, bool)>,
    alt_screen: Option<u16>,
}

impl Default for ModeTracker {
    fn default() -> Self {
        Self {
            state: ParseState::Ground,
            params: Vec::new(),
            private: false,
            modes: TRACKED_MODES.to_vec(),
            alt_screen: None,
        }
    }
}

impl ModeTracker {
    pub fn feed(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.step(byte);
        }
    }

    /// True between sequences, where a replay can start without a partial escape.
    pub fn at_boundary(&self) -> bool {
        self.state == ParseState::Ground
    }

    pub fn mode(&self, mode: u16) -> Option<bool> {
        if ALT_SCREEN_MODES.contains(&mode) {
            return Some(self.alt_screen == Some(mode));
        }
        self.modes.iter().find(|(id, _)| *id == mode).map(|(_, enabled)| *enabled)
    }

    pub fn alternate_screen(&self) -> bool {
        self.alt_screen.is_some()
    }

    /// Sequences that bring a fresh terminal to the recorded modes.
    pub fn prelude(&self) -> Vec<u8> {
        let mut out = String::new();
        if let Some(mode) = self.alt_screen {
            out.push_str(&format!("\u{1b}[?{mode}h"));
        }
        for ((mode, enabled), (_, default)) in self.modes.iter().zip(TRACKED_MODES) {
            if enabled != default {
                out.push_str(&format!("\u{1b}[?{mode}{}", if *enabled { 'h' } else { 'l' }));
            }
        }
        out.into_bytes()
    }

    fn reset(&mut self) {
        self.modes = TRACKED_MODES.to_vec();
        self.alt_screen = None;
    }

    fn step(&mut self, byte: u8) {
        match self.state {
            ParseState::Ground => {
                if byte == 0x1b {
                    self.state = ParseState::Escape;
                } else if byte == 0x9b {
                    self.begin_csi();
                }
            }
            ParseState::Escape => match byte {
                b'[' => self.begin_csi(),
                b']' | b'P' | b'X' | b'^' | b'_' => self.state = ParseState::String,
                b'c' => {
                    self.reset();
                    self.state = ParseState::Ground;
                }
                0x20..=0x2f => self.state = ParseState::EscapeIntermediate,
                0x1b => self.state = ParseState::Escape,
                _ => self.state = ParseState::Ground,
            },
            ParseState::EscapeIntermediate => {
                if !(0x20..=0x2f).contains(&byte) {
                    self.state = ParseState::Ground;
                }
            }
            ParseState::Csi => match byte {
                b'?' if self.params.is_empty() => self.private = true,
                b'0'..=b'9' | b';' | b':' => {
                    if self.params.len() < 64 {
                        self.params.push(byte);
                    }
                }
                0x1b => self.state = ParseState::Escape,
                0x40..=0x7e => {
                    if self.private && (byte == b'h' || byte == b'l') {
                        self.apply_private(byte == b'h');
                    }
                    self.state = ParseState::Ground;
                }
                // Intermediates and other parameter bytes do not end the sequence.
                _ => {}
            },
            ParseState::String => match byte {
                0x07 => self.state = ParseState::Ground,
                0x1b => self.state = ParseState::StringEscape,
                _ => {}
            },
            ParseState::StringEscape => {
                self.state = if byte == b'\\' { ParseState::Ground } else { ParseState::String };
            }
        }
    }

    fn begin_csi(&mut self) {
        self.state = ParseState::Csi;
        self.params.clear();
        self.private = false;
    }

    fn apply_private(&mut self, enabled: bool) {
        let params = std::mem::take(&mut self.params);
        for part in params.split(|byte| *byte == b';' || *byte == b':') {
            let Some(mode) = std::str::from_utf8(part).ok().and_then(|text| text.parse::<u16>().ok()) else { continue };
            if ALT_SCREEN_MODES.contains(&mode) {
                if enabled {
                    self.alt_screen = Some(mode);
                } else if self.alt_screen.is_some() {
                    self.alt_screen = None;
                }
                continue;
            }
            if let Some(slot) = self.modes.iter_mut().find(|(id, _)| *id == mode) {
                slot.1 = enabled;
            }
        }
    }
}

/// The newest output of one session plus the modes in force where it begins.
#[derive(Debug)]
pub struct ReplayBuffer {
    bytes: VecDeque<u8>,
    /// Total bytes ever pushed; the stream offset just past the newest byte.
    end: u64,
    limit: usize,
    /// Mode state at the first retained byte.
    front: ModeTracker,
}

impl ReplayBuffer {
    pub fn new(limit: usize) -> Self {
        Self { bytes: VecDeque::new(), end: 0, limit, front: ModeTracker::default() }
    }

    /// Append output and return the stream offset of its first byte.
    pub fn push(&mut self, data: &[u8]) -> u64 {
        let start = self.end;
        self.bytes.extend(data);
        self.end += data.len() as u64;
        self.trim();
        start
    }

    pub fn end(&self) -> u64 {
        self.end
    }

    /// Restoring prelude followed by the retained bytes, and the offset they end at.
    pub fn snapshot(&self) -> (Vec<u8>, u64) {
        let mut out = self.front.prelude();
        out.extend(self.bytes.iter().copied());
        (out, self.end)
    }

    fn trim(&mut self) {
        if self.bytes.len() <= self.limit {
            return;
        }
        let overflow = self.bytes.len() - self.limit;
        let dropped: Vec<u8> = self.bytes.drain(..overflow).collect();
        self.front.feed(&dropped);
        // Move the start out of a partial escape sequence or UTF-8 character so the
        // replay does not begin with stray parameters or a replacement glyph.
        let mut skipped = 0;
        while skipped < MAX_BOUNDARY_SKIP {
            let Some(&next) = self.bytes.front() else { break };
            let clean = self.front.at_boundary() && !(0x80..=0xbf).contains(&next);
            if clean {
                break;
            }
            self.bytes.pop_front();
            self.front.feed(&[next]);
            skipped += 1;
        }
    }
}

#[cfg(test)]
#[path = "../../tests/launch/terminal_replay.rs"]
mod tests;
