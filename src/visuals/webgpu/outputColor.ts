/**
 * Canvas output color for the WGSL passes (#259 W5).
 *
 * Every shader palette is authored in sRGB. On an sRGB canvas (the default) the
 * output is passed through. With `?p3=1` on a P3 display the canvas is configured
 * `display-p3`, which would read those sRGB values as P3 primaries and oversaturate
 * them, so the final color is converted: clamp to the sRGB range the default canvas
 * shows, linearize, sRGB→P3 primaries, re-encode (P3 uses the sRGB transfer curve).
 */

/** Linear sRGB → linear Display P3 (D65), rows of the 3×3 matrix. */
export const SRGB_TO_P3_ROWS: readonly (readonly [number, number, number])[] = [
  [0.8224621, 0.1775380, 0.0],
  [0.0331941, 0.9668058, 0.0],
  [0.0170827, 0.0723974, 0.9105199],
];

function vec3(row: readonly number[]): string {
  return `vec3<f32>(${row.map((v) => v.toFixed(7)).join(', ')})`;
}

/** WGSL `fn toOutputColor(c: vec3<f32>) -> vec3<f32>` for the given canvas color space. */
export function outputColorWGSL(colorSpace: PredefinedColorSpace = 'srgb'): string {
  if (colorSpace !== 'display-p3') {
    return 'fn toOutputColor(c: vec3<f32>) -> vec3<f32> { return c; }';
  }
  const [r, g, b] = SRGB_TO_P3_ROWS;
  return `
fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
  return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}
fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  return select(1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3<f32>(0.0031308));
}
fn toOutputColor(c: vec3<f32>) -> vec3<f32> {
  let lin = srgbToLinear(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)));
  let p3 = vec3<f32>(dot(${vec3(r!)}, lin), dot(${vec3(g!)}, lin), dot(${vec3(b!)}, lin));
  return linearToSrgb(clamp(p3, vec3<f32>(0.0), vec3<f32>(1.0)));
}`;
}

/** CPU mirror of the WGSL conversion (unit tests, palette checks). */
export function srgbToDisplayP3(c: readonly [number, number, number]): [number, number, number] {
  const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const toEncoded = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const lin = c.map((v) => toLinear(clamp01(v)));
  return SRGB_TO_P3_ROWS.map((row) =>
    toEncoded(clamp01(row[0] * lin[0]! + row[1] * lin[1]! + row[2] * lin[2]!))) as [number, number, number];
}
