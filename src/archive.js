// The c0mpute private storage copy of a finished recording.
//
// The MP3 is sealed on this server with @profullstack/c0mpute-sealed (format c0mpute-private-v1)
// and uploaded over c0mpute.com's app-upload API (storage:write): POST /api/v1/storage/uploads
// for a ticket, PUT the sealed pieces to the ingest gateway, finish. That needs no c0mpute node
// or identity on this host, only BOARD_C0MPUTE_STORAGE_TOKEN (a c0mpute OAuth token or API key
// with storage:write). The object lands in the private storage of the c0mpute account that owns
// that token, which must have a linked storage identity (`c0mpute storage key link`, run once,
// on any machine of that account).
//
// What comes back is a private link, https://gateway.c0mpute.com/p/<id>/#k=<key>. Be clear
// about what it is: the key rides in the link, so anyone holding the link can open the file,
// and revoking a board share does not take back a link somebody already copied. This server
// therefore stores it only encrypted under BOARD_RECORDING_KEK and shows it only to the owner
// and to shares the owner made with allow_download.
//
// The encrypted copy on this box stays the primary; a failed upload is logged and nothing else.

/** Objects over 192 MiB are stored as parts plus a root, which a browser link cannot open. */
export const MAX_ARCHIVE_BYTES = 192 * 1024 * 1024;

export function createArchive({ token, baseUrl = 'https://c0mpute.com', fetchImpl = fetch, log = () => {}, upload = null } = {}) {
  return {
    configured: !!token,
    /** -> { ref, link } or { skipped: reason }. Throws when the upload fails. */
    async put(mp3, { fileName = 'board-meeting.mp3' } = {}) {
      if (!token) return { skipped: 'not configured' };
      if (mp3.length > MAX_ARCHIVE_BYTES) {
        log(`c0mpute archive skipped: ${mp3.length} bytes is over 192 MiB, which a browser link cannot open`);
        return { skipped: 'over 192 MiB' };
      }
      const uploadSealed = upload ?? (await import('@profullstack/c0mpute-sealed')).uploadSealed;
      const r = await uploadSealed(new Uint8Array(mp3.buffer, mp3.byteOffset, mp3.length), { token, baseUrl, fetch: fetchImpl, fileName, contentType: 'audio/mpeg', signal: AbortSignal.timeout(15 * 60_000) });
      if (!r?.link || !r?.ref) throw new Error('c0mpute storage returned no link');
      return { ref: r.ref, link: r.link, status: r.status ?? null, copies: r.copies ?? 0 };
    },
  };
}
