"use client";

/* When Google's filter stops a reply and the app has already tried the milder
 * versions it has, this offers three ways to keep going instead of a dead end.
 * One tap each; none of them asks the model for anything stronger. */
export function BlockedSheet({
  name,
  nextHeat,
  canReword,
  onSofter,
  onReword,
  onMoveOn,
  onClose,
}: {
  name: string;
  /** The milder heat on offer (a label), or null when there is nowhere milder to go. */
  nextHeat: string | null;
  /** Whether the last message is text that can be put back in the box. */
  canReword: boolean;
  onSofter: () => void;
  onReword: () => void;
  onMoveOn: () => void;
  onClose: () => void;
}) {
  return (
    <div className="blocked-sheet" role="alertdialog" aria-labelledby="blocked-title">
      <p id="blocked-title" className="blocked-title">Google&apos;s filter stopped that one.</p>
      <p className="fine" style={{ margin: "0.2rem 0 0.7rem" }}>Pick a way to keep going:</p>
      <div className="blocked-options">
        <button className="blocked-opt" onClick={onSofter}>
          <b>{nextHeat ? `Try a softer version (${nextHeat})` : "Try again"}</b>
          <span>{nextHeat ? `${name} answers the same message, a little milder.` : `Ask ${name} once more.`}</span>
        </button>
        {canReword && (
          <button className="blocked-opt" onClick={onReword}>
            <b>Reword my message</b>
            <span>Put it back in the box so you can change it.</span>
          </button>
        )}
        <button className="blocked-opt" onClick={onMoveOn}>
          <b>Move the scene on</b>
          <span>{name} picks up from a little later.</span>
        </button>
      </div>
      <button className="link-btn" onClick={onClose}>Never mind</button>
    </div>
  );
}
