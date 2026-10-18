/**
 * Remounts on every navigation between the app's pages (template.js), so each page fades in.
 * Purely CSS; with reduced motion the animation ends at once (globals.css).
 */
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return <div className="animate-fade-up">{children}</div>;
}
