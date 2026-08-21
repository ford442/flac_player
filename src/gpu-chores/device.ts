/**
 * Adopt the visualizer's GPUDevice. Never call requestAdapter/requestDevice here.
 * Chrome vs Edge WebGPU flakes must not take down playback — callers fall back
 * to Worker/CPU when this registry is empty or the device is lost.
 */

let adopted: GPUDevice | null = null;
let lostHooked: GPUDevice | null = null;

function hookLost(device: GPUDevice): void {
  if (lostHooked === device) return;
  lostHooked = device;
  void device.lost.then(() => {
    if (adopted === device) adopted = null;
    if (lostHooked === device) lostHooked = null;
  });
}

export function adoptVisualizerDevice(device: GPUDevice | null): void {
  adopted = device;
  if (device) hookLost(device);
}

export function releaseVisualizerDevice(device?: GPUDevice | null): void {
  if (device && adopted !== device) return;
  adopted = null;
}

export function getAdoptedDevice(): GPUDevice | null {
  return adopted;
}

/** True when chores may run compute on the visualizer device (no second requestDevice). */
export function hasAdoptedVisualizerDevice(): boolean {
  return adopted !== null;
}
