//! Hand-rolled protobuf wire walker for Antigravity `gen_metadata` blobs.
//!
//! [RE] evidence (codeburn's reverse engineering of `agy` 1.2.x, cross-checked
//! against the documented schema; field numbers may drift in 1.3.x — 02 ADR-2
//! evidence policy): pure `std` varint/field walking with NO new crates, and
//! only the documented fields are ever decoded. Any structural mismatch —
//! truncated buffer, impossible wire type, or a documented field number that
//! arrives with an unexpected wire type — fails that value as a
//! [`Mismatch`]; the caller skips the row and marks the session partial
//! instead of guessing. Unknown field numbers are ordinary protobuf unknown
//! fields and are skipped harmlessly by wire type.

/// Structural mismatch: the blob does not match the documented schema.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct Mismatch;

/// One decoded protobuf field value. Fixed-width payloads are consumed for
/// walking but carry no documented meaning in this schema, so only their
/// shape is kept.
#[derive(Debug)]
pub(crate) enum Field<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
    Fixed32,
    Fixed64,
}

impl<'a> Field<'a> {
    /// Documented varint fields must arrive as varints; anything else is drift.
    pub(crate) fn as_varint(&self) -> Result<u64, Mismatch> {
        match self {
            Field::Varint(value) => Ok(*value),
            _ => Err(Mismatch),
        }
    }
    /// Documented submessage/string fields must arrive length-delimited. The
    /// returned slice borrows the underlying buffer, not the field handle.
    pub(crate) fn as_bytes(&self) -> Result<&'a [u8], Mismatch> {
        match self {
            Field::Bytes(bytes) => Ok(bytes),
            _ => Err(Mismatch),
        }
    }
}

pub(crate) struct Reader<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Reader { data, position: 0 }
    }

    pub(crate) fn done(&self) -> bool {
        self.position >= self.data.len()
    }

    /// Reads the next (field number, wire type, value) triple. Wire types 3/4
    /// (legacy groups) are rejected: the documented schema never uses them.
    pub(crate) fn next(&mut self) -> Result<(u64, u8, Field<'a>), Mismatch> {
        let (tag, consumed) = read_varint(&self.data[self.position..])?;
        self.position += consumed;
        let number = tag >> 3;
        let wire = (tag & 0x07) as u8;
        if number == 0 {
            return Err(Mismatch);
        }
        let value = match wire {
            0 => {
                let (value, consumed) = read_varint(&self.data[self.position..])?;
                self.position += consumed;
                Field::Varint(value)
            }
            1 => {
                self.take(8)?;
                Field::Fixed64
            }
            2 => {
                let (length, consumed) = read_varint(&self.data[self.position..])?;
                self.position += consumed;
                let start = self.position;
                let length = usize::try_from(length).map_err(|_| Mismatch)?;
                let end = start.checked_add(length).ok_or(Mismatch)?;
                Field::Bytes(self.take_to(end)?)
            }
            5 => {
                self.take(4)?;
                Field::Fixed32
            }
            _ => return Err(Mismatch),
        };
        Ok((number, wire, value))
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], Mismatch> {
        let end = self.position.checked_add(length).ok_or(Mismatch)?;
        self.take_to(end)
    }

    fn take_to(&mut self, end: usize) -> Result<&'a [u8], Mismatch> {
        if end > self.data.len() {
            return Err(Mismatch);
        }
        let slice = &self.data[self.position..end];
        self.position = end;
        Ok(slice)
    }
}

fn read_varint(data: &[u8]) -> Result<(u64, usize), Mismatch> {
    let mut value: u64 = 0;
    let mut shift = 0u32;
    for (index, byte) in data.iter().enumerate() {
        if shift >= 64 {
            return Err(Mismatch);
        }
        let bits = u64::from(byte & 0x7f).checked_shl(shift).ok_or(Mismatch)?;
        value |= bits;
        if byte & 0x80 == 0 {
            return Ok((value, index + 1));
        }
        shift += 7;
    }
    // Ran out of bytes inside a varint: truncated blob.
    Err(Mismatch)
}

/// Minimal encoder used by module tests to rebuild the sanitized fixture rows
/// deterministically; production code only ever decodes.
#[cfg(test)]
pub(crate) mod encode {
    fn tag(number: u64, wire: u8) -> Vec<u8> {
        let mut out = Vec::new();
        push_varint(number << 3 | u64::from(wire), &mut out);
        out
    }

    fn push_varint(mut value: u64, out: &mut Vec<u8>) {
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return;
            }
            out.push(byte | 0x80);
        }
    }

    pub(crate) fn varint_field(number: u64, value: u64) -> Vec<u8> {
        let mut out = tag(number, 0);
        push_varint(value, &mut out);
        out
    }

    pub(crate) fn bytes_field(number: u64, payload: &[u8]) -> Vec<u8> {
        let mut out = tag(number, 2);
        push_varint(payload.len() as u64, &mut out);
        out.extend_from_slice(payload);
        out
    }

    pub(crate) fn string_field(number: u64, text: &str) -> Vec<u8> {
        bytes_field(number, text.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walker_decodes_varints_and_length_delimited_fields() {
        // field 2 varint 150, field 4 bytes "ab" — canonical protobuf examples.
        let mut blob = encode::varint_field(2, 150);
        blob.extend(encode::string_field(4, "ab"));
        let mut reader = Reader::new(&blob);
        let (number, _, value) = reader.next().unwrap();
        assert_eq!((number, value.as_varint().unwrap()), (2, 150));
        let (number, _, value) = reader.next().unwrap();
        assert_eq!(number, 4);
        assert_eq!(value.as_bytes().unwrap(), b"ab");
        assert!(reader.done());
    }

    #[test]
    fn truncated_or_impossible_input_is_a_mismatch() {
        assert!(matches!(Reader::new(&[0x08]).next(), Err(Mismatch))); // truncated varint
        assert!(matches!(Reader::new(&[0x0b]).next(), Err(Mismatch))); // wire type 3 group
        // Declared length overruns the buffer.
        assert!(matches!(Reader::new(&[0x0a, 0x05, b'a']).next(), Err(Mismatch)));
        // Varint longer than 10 bytes never terminates.
        assert!(matches!(Reader::new(&[0xffu8; 11]).next(), Err(Mismatch)));
    }

    #[test]
    fn documented_field_with_wrong_wire_type_is_a_mismatch() {
        // Field 2 documented as varint arrives length-delimited: drift, fail.
        let blob = encode::string_field(2, "150");
        let mut reader = Reader::new(&blob);
        let (_, _, value) = reader.next().unwrap();
        assert_eq!(value.as_varint(), Err(Mismatch));
    }

    #[test]
    fn unknown_field_numbers_are_skipped_by_wire_type() {
        // Fixed64 and fixed32 unknown fields walk past without interpretation.
        let mut blob = vec![0x09, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];
        blob.extend([0x0d, 0x01, 0x02, 0x03, 0x04]);
        blob.extend(encode::varint_field(4, 7));
        let mut reader = Reader::new(&blob);
        let mut found = None;
        while !reader.done() {
            let (number, _, field) = reader.next().unwrap();
            if number == 4 {
                found = Some(field.as_varint().unwrap());
            }
        }
        assert_eq!(found, Some(7));
    }
}
