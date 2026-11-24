// VS Code's official logo mark (Simple Icons, CC0 data; the mark itself is a
// Microsoft trademark). Used only as the "open in VS Code" affordance, not as a
// product or endorsement claim. Single path so it stays legible at 16px.
const MARK = 'M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z';

/** The brand blue keeps the button readable as VS Code next to the muted
 * currentColor icons, without adding a second icon set. */
export default function VscodeLogo({ size = 16 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="#007acc" aria-hidden="true" focusable="false"><path d={MARK} /></svg>;
}
