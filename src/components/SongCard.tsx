"use client";

/* A song they sent. Opens a search rather than a guessed link: the model knows
   songs by name, not by URL, and a search for the right title always lands. */
export function SongCard({ title, artist }: { title: string; artist: string }) {
  const q = encodeURIComponent(`${title} ${artist}`.trim());
  return (
    <div className="song">
      <span className="song-icon" aria-hidden="true">♪</span>
      <span className="song-name">
        <b>{title}</b>
        {artist && <span>{artist}</span>}
      </span>
      <span className="song-links">
        <a href={`https://music.youtube.com/search?q=${q}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>YouTube</a>
        <a href={`https://open.spotify.com/search/${q}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>Spotify</a>
      </span>
    </div>
  );
}
