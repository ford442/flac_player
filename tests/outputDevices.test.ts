import { describe, it, expect } from 'vitest';
import { listOutputDevices } from '../src/hooks/useAudioOutputInfo';

const device = (kind: MediaDeviceKind, deviceId: string, label = ''): MediaDeviceInfo =>
  ({ kind, deviceId, label, groupId: '', toJSON: () => ({}) }) as MediaDeviceInfo;

describe('listOutputDevices (#259 A7)', () => {
  it('flags outputs whose ids the browser blanked instead of silently dropping them', () => {
    const result = listOutputDevices([device('audioinput', ''), device('audiooutput', '')]);
    expect(result).toEqual({ devices: [], hidden: true });
  });

  it('lists real outputs, skipping the "default" alias and inputs', () => {
    const result = listOutputDevices([
      device('audiooutput', 'default', 'Default'),
      device('audiooutput', 'usb', 'USB DAC'),
      device('audiooutput', 'hdmi'),
      device('audioinput', 'mic', 'Mic'),
    ]);
    expect(result.hidden).toBe(false);
    expect(result.devices).toEqual([
      { deviceId: 'usb', label: 'USB DAC' },
      { deviceId: 'hdmi', label: 'Output 2' },
    ]);
  });
});
