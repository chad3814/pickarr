/**
 * What one submission gave back: the reference this client's own history
 * later answers questions about. Shared by every adapter rather than
 * declared once per client, because a caller that submits to either
 * SABnzbd or qBittorrent needs to treat both results the same way without
 * knowing which implementation it is talking to.
 *
 * `ref` is nullable because qBittorrent's `.torrent` url path needs that:
 * a `.torrent` file's infohash lives inside the file, not in the link, so
 * right after adding, a lookup may not find the torrent yet (see
 * `qbittorrent.ts`'s `submit`). SABnzbd never returns `null` -- its
 * `addurl` answers with the reference directly, and `sabnzbd.ts` refuses a
 * submission it cannot name a reference for rather than ever handing one
 * back. The nullability exists for qBittorrent's benefit alone; SABnzbd's
 * adapter simply never exercises it.
 */
export interface SubmitResult {
  ref: string | null;
}
