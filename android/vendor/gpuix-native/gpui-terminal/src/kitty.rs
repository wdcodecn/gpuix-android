//! Presents rendered frames with the kitty graphics protocol.
//!
//! When the terminal runs on this machine, each frame is a POSIX shared
//! memory object (`t=s`) that the GPU readback writes into directly, so the
//! pty only carries a ~100 byte escape code. Over SSH the terminal cannot open
//! our shared memory, so frames are sent inline instead: zlib-compressed,
//! base64, in 4096 byte chunks (`t=d,o=z`).
//!
//! Which one works is asked once at startup, like kitty's own `icat` does: a
//! one pixel shared memory query (`a=q,t=s`) followed by `CSI c`. Terminals
//! answer in order, so a device attributes reply without an `OK` for the query
//! means shared memory is not reachable.
//!
//! Re-transmitting image id 1 with placement id 1 (`a=T,i=1,p=1`) replaces the
//! old frame and its placement in one command, and the synchronized update
//! brackets (`CSI ? 2026`) keep it flicker free.
//! https://sw.kovidgoyal.net/kitty/graphics-protocol/

use std::{
    collections::VecDeque,
    ffi::CString,
    io::{self, Write as _},
    ptr,
    time::{Duration, Instant},
};

use anyhow::{Context as _, Result};
use base64::Engine as _;

use crate::tty::Tty;

/// Frames whose shared memory object we still own. The terminal unlinks an
/// object once it read it; we unlink anything older than this ourselves, so a
/// terminal that stops reading cannot leak memory without bound.
const IN_FLIGHT_FRAMES: usize = 4;
/// Image id of the startup shared memory query.
const PROBE_ID: u32 = 0x4750_0001;
/// A terminal that answers neither the query nor `CSI c` gets inline frames.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// Inline frames are followed by a query whose reply says the terminal
/// consumed them. Each fence gets a fresh id from this range.
const FENCE_ID_START: u32 = 0x4750_1000;
const FENCE_ID_COUNT: u32 = 0x1_0000;
/// Inline frames that may be on their way to the terminal. More would only
/// sit in the SSH buffers and delay the response to input.
const MAX_UNACKED_FRAMES: usize = 2;
/// A fence that never got a reply stops holding frames back after this.
const FENCE_TIMEOUT: Duration = Duration::from_secs(2);
/// Kitty's limit for the base64 payload of one escape code.
const CHUNK_SIZE: usize = 4096;

enum Transport {
    /// Waiting for the terminal to answer the shared memory query.
    Probing {
        /// Must stay mapped and linked until the terminal answered.
        _probe: SharedMemory,
        deadline: Instant,
    },
    SharedMemory,
    Inline,
}

pub(crate) struct KittyPresenter {
    transport: Transport,
    process_id: u32,
    frame_counter: u64,
    in_flight: VecDeque<CString>,
    command: Vec<u8>,
    /// Reused render target for inline frames.
    inline_pixels: Vec<u8>,
    fences: VecDeque<(u32, Instant)>,
    next_fence: u32,
}

/// A frame the next scene is rendered into.
pub(crate) struct Frame {
    width: u32,
    height: u32,
    target: Target,
}

enum Target {
    Shared(SharedMemory),
    Inline(Vec<u8>),
}

impl Frame {
    pub(crate) fn pixels(&mut self) -> &mut [u8] {
        match &mut self.target {
            Target::Shared(shared) => shared.bytes(),
            Target::Inline(pixels) => pixels,
        }
    }
}

/// A mapped POSIX shared memory object. Dropping it unlinks the object unless
/// it was handed to the terminal, which unlinks it after reading.
struct SharedMemory {
    name: CString,
    mapping: *mut libc::c_void,
    length: usize,
    presented: bool,
}

impl SharedMemory {
    fn bytes(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.mapping as *mut u8, self.length) }
    }
}

impl Drop for SharedMemory {
    fn drop(&mut self) {
        unsafe { libc::munmap(self.mapping, self.length) };
        if !self.presented {
            unsafe { libc::shm_unlink(self.name.as_ptr()) };
        }
    }
}

impl KittyPresenter {
    /// Asks the terminal whether it can read our shared memory. No frame can
    /// be presented until `wait_until` returns `None`.
    pub(crate) fn new(tty: &mut Tty) -> Result<Self> {
        let mut presenter = Self {
            transport: Transport::Inline,
            process_id: std::process::id(),
            frame_counter: 0,
            in_flight: VecDeque::new(),
            command: Vec::new(),
            inline_pixels: Vec::new(),
            fences: VecDeque::new(),
            next_fence: 0,
        };
        let mut probe = match presenter.create_shared_memory(3) {
            Ok(probe) => probe,
            Err(error) => {
                log::info!("no shared memory ({error:#}), sending frames inline");
                return Ok(presenter);
            }
        };
        probe.bytes().fill(0);
        let encoded_name = base64::engine::general_purpose::STANDARD.encode(probe.name.as_bytes());
        tty.write_all(
            format!("\x1b_Ga=q,i={PROBE_ID},s=1,v=1,f=24,t=s,S=3;{encoded_name}\x1b\\\x1b[c")
                .as_bytes(),
        )?;
        presenter.transport = Transport::Probing {
            _probe: probe,
            deadline: Instant::now() + PROBE_TIMEOUT,
        };
        Ok(presenter)
    }

    pub(crate) fn handle_reply(&mut self, id: u32, ok: bool) {
        if id == PROBE_ID {
            if matches!(self.transport, Transport::Probing { .. }) {
                self.choose(if ok {
                    Transport::SharedMemory
                } else {
                    Transport::Inline
                });
            }
            return;
        }
        // Replies arrive in order, so a fence's reply also answers every older one.
        if let Some(index) = self.fences.iter().position(|(fence, _)| *fence == id) {
            self.fences.drain(..=index);
        }
    }

    pub(crate) fn handle_device_attributes(&mut self) {
        if matches!(self.transport, Transport::Probing { .. }) {
            self.choose(Transport::Inline);
        }
    }

    fn choose(&mut self, transport: Transport) {
        match transport {
            Transport::SharedMemory => log::info!("sending frames through shared memory"),
            _ => log::info!("the terminal cannot read our shared memory, sending frames inline"),
        }
        self.transport = transport;
    }

    /// When a frame cannot be presented yet, the time to check again. A
    /// terminal reply may also make it ready earlier.
    pub(crate) fn wait_until(&mut self, now: Instant) -> Option<Instant> {
        if let Transport::Probing { deadline, .. } = self.transport {
            if now < deadline {
                return Some(deadline);
            }
            log::warn!("the terminal did not answer the graphics query");
            self.choose(Transport::Inline);
        }
        while self.fences.len() >= MAX_UNACKED_FRAMES {
            let (_, sent) = self.fences.front()?;
            let expires = *sent + FENCE_TIMEOUT;
            if now < expires {
                return Some(expires);
            }
            self.fences.pop_front();
        }
        None
    }

    /// Allocates the target for an RGBA frame of `width` x `height`.
    /// Dropping the frame without `present` discards it.
    pub(crate) fn begin_frame(&mut self, width: u32, height: u32) -> Result<Frame> {
        let length = width as usize * height as usize * 4;
        let target = match self.transport {
            Transport::Probing { .. } => anyhow::bail!("the frame transport is not known yet"),
            Transport::SharedMemory => Target::Shared(self.create_shared_memory(length)?),
            Transport::Inline => {
                let mut pixels = std::mem::take(&mut self.inline_pixels);
                pixels.resize(length, 0);
                Target::Inline(pixels)
            }
        };
        Ok(Frame {
            width,
            height,
            target,
        })
    }

    /// Shows `frame` covering the grid from its top-left cell.
    pub(crate) fn present(&mut self, tty: &mut Tty, frame: Frame) -> Result<()> {
        self.command.clear();
        match frame.target {
            Target::Shared(mut shared) => {
                if self.in_flight.len() >= IN_FLIGHT_FRAMES
                    && let Some(stale) = self.in_flight.pop_front()
                {
                    // ENOENT is the normal case: the terminal already unlinked it.
                    unsafe { libc::shm_unlink(stale.as_ptr()) };
                }
                let encoded_name =
                    base64::engine::general_purpose::STANDARD.encode(shared.name.as_bytes());
                write!(
                    self.command,
                    "\x1b[?2026h\x1b[H\x1b_Ga=T,i=1,p=1,f=32,t=s,s={},v={},S={},C=1,q=2;{encoded_name}\x1b\\\x1b[?2026l",
                    frame.width, frame.height, shared.length,
                )?;
                shared.presented = true;
                self.in_flight.push_back(shared.name.clone());
            }
            Target::Inline(pixels) => {
                let fence = FENCE_ID_START + self.next_fence;
                self.next_fence = (self.next_fence + 1) % FENCE_ID_COUNT;
                write_inline_frame(&mut self.command, &pixels, frame.width, frame.height, fence)?;
                self.fences.push_back((fence, Instant::now()));
                self.inline_pixels = pixels;
            }
        }
        // TODO: over a slow link this write blocks the main thread until the
        // link drains. A writer thread would keep input responsive; the fence
        // gate already bounds it to two frames.
        tty.write_all(&self.command)
    }

    fn create_shared_memory(&mut self, length: usize) -> Result<SharedMemory> {
        // macOS caps shared memory names at 31 bytes including the slash.
        let name = format!("/gpui{:x}.{:x}", self.process_id, self.frame_counter);
        self.frame_counter += 1;
        let name = CString::new(name).context("shared memory name")?;
        let mapping = map_shared_memory(&name, length)?;
        Ok(SharedMemory {
            name,
            mapping,
            length,
            presented: false,
        })
    }
}

impl Drop for KittyPresenter {
    fn drop(&mut self) {
        for name in self.in_flight.drain(..) {
            unsafe { libc::shm_unlink(name.as_ptr()) };
        }
    }
}

/// Appends an RGBA frame as chunked `t=d,o=z` escape codes, then a one pixel
/// query with id `fence` whose reply tells us the terminal got this far.
fn write_inline_frame(
    command: &mut Vec<u8>,
    pixels: &[u8],
    width: u32,
    height: u32,
    fence: u32,
) -> Result<()> {
    let mut encoder = flate2::write::ZlibEncoder::new(
        Vec::with_capacity(pixels.len() / 16),
        flate2::Compression::fast(),
    );
    encoder.write_all(pixels)?;
    let payload = base64::engine::general_purpose::STANDARD.encode(encoder.finish()?);
    command.extend_from_slice(b"\x1b[?2026h\x1b[H");
    let mut chunks = payload.as_bytes().chunks(CHUNK_SIZE).peekable();
    let mut first = true;
    while let Some(chunk) = chunks.next() {
        let more = u8::from(chunks.peek().is_some());
        if first {
            write!(
                command,
                "\x1b_Ga=T,i=1,p=1,f=32,o=z,t=d,s={width},v={height},C=1,q=2,m={more};"
            )?;
            first = false;
        } else {
            write!(command, "\x1b_Gm={more},q=2;")?;
        }
        command.extend_from_slice(chunk);
        command.extend_from_slice(b"\x1b\\");
    }
    write!(
        command,
        "\x1b[?2026l\x1b_Ga=q,i={fence},s=1,v=1,f=24,t=d;AAAA\x1b\\"
    )?;
    Ok(())
}

/// macOS refuses write(2) on shared memory, so the object is always mapped.
/// On Linux the pages are allocated up front: a full `/dev/shm` (64 MB in
/// Docker by default) then fails here with ENOSPC instead of a SIGBUS on write.
fn map_shared_memory(name: &CString, length: usize) -> Result<*mut libc::c_void> {
    let fd = unsafe {
        libc::shm_open(
            name.as_ptr(),
            libc::O_CREAT | libc::O_EXCL | libc::O_RDWR,
            0o600 as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error()).context("shm_open");
    }
    let result = if let Err(error) = allocate(fd, length) {
        Err(error)
    } else {
        let mapping = unsafe {
            libc::mmap(
                ptr::null_mut(),
                length,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd,
                0,
            )
        };
        if mapping == libc::MAP_FAILED {
            Err(io::Error::last_os_error()).context("mmap")
        } else {
            Ok(mapping)
        }
    };
    unsafe { libc::close(fd) };
    if result.is_err() {
        unsafe { libc::shm_unlink(name.as_ptr()) };
    }
    result
}

#[cfg(target_os = "macos")]
fn allocate(fd: libc::c_int, length: usize) -> Result<()> {
    if unsafe { libc::ftruncate(fd, length as libc::off_t) } != 0 {
        return Err(io::Error::last_os_error()).context("ftruncate");
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn allocate(fd: libc::c_int, length: usize) -> Result<()> {
    // posix_fallocate returns the error number instead of setting errno.
    match unsafe { libc::posix_fallocate(fd, 0, length as libc::off_t) } {
        0 => Ok(()),
        error => Err(io::Error::from_raw_os_error(error)).context("posix_fallocate"),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read as _;

    use super::*;

    #[test]
    fn inline_frames_are_chunked_and_fenced() {
        let (width, height) = (64u32, 48u32);
        // Noise, so the compressed payload spans several chunks.
        let mut seed = 0x9e37_79b9u32;
        let pixels: Vec<u8> = (0..width * height * 4)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (seed >> 24) as u8
            })
            .collect();
        let mut command = Vec::new();
        write_inline_frame(&mut command, &pixels, width, height, 77).unwrap();
        let text = String::from_utf8(command).unwrap();

        let body = text
            .strip_prefix("\x1b[?2026h\x1b[H")
            .unwrap()
            .strip_suffix("\x1b[?2026l\x1b_Ga=q,i=77,s=1,v=1,f=24,t=d;AAAA\x1b\\")
            .unwrap();
        let codes: Vec<&str> = body
            .split("\x1b\\")
            .filter(|code| !code.is_empty())
            .collect();
        assert!(codes.len() > 1, "expected several chunks");
        let mut payload = String::new();
        for (index, code) in codes.iter().enumerate() {
            let (keys, chunk) = code
                .strip_prefix("\x1b_G")
                .unwrap()
                .split_once(';')
                .unwrap();
            let last = index == codes.len() - 1;
            let expected_keys = match (index, last) {
                (0, _) => format!(
                    "a=T,i=1,p=1,f=32,o=z,t=d,s={width},v={height},C=1,q=2,m={}",
                    u8::from(!last)
                ),
                (_, false) => "m=1,q=2".to_owned(),
                (_, true) => "m=0,q=2".to_owned(),
            };
            assert_eq!(keys, expected_keys);
            assert!(chunk.len() <= CHUNK_SIZE);
            if !last {
                assert_eq!(chunk.len() % 4, 0);
            }
            payload.push_str(chunk);
        }

        let compressed = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .unwrap();
        let mut decoded = Vec::new();
        flate2::read::ZlibDecoder::new(compressed.as_slice())
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded, pixels);
    }
}
