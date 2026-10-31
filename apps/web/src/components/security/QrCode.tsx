import qrcode from "qrcode-generator";
import { useMemo } from "react";

/**
 * A QR code drawn as SVG rectangles by React (no HTML string is injected).
 * Dark modules on white whatever the theme: phone cameras read that best.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let path = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) if (qr.isDark(row, col)) path += `M${col + 4} ${row + 4}h1v1h-1z`;
    }
    return { size: count + 8, path };
  }, [value]);
  return (
    <svg viewBox={`0 0 ${cells.size} ${cells.size}`} className="h-48 w-48 rounded-lg" role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={cells.size} height={cells.size} fill="#ffffff" />
      <path d={cells.path} fill="#000000" />
    </svg>
  );
}
