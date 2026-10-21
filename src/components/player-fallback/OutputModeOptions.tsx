import React from 'react';
import type { AudioOutputMode } from '../../types/audio';
import { outputModeUnavailableReason } from '../../audio/outputModeSupport';
import { OUTPUT_MODE_LABELS } from './types';

/** `<option>`s for every engine; ones this page cannot run are disabled with the reason. */
export const OutputModeOptions: React.FC = () => (
  <>
    {(Object.entries(OUTPUT_MODE_LABELS) as [AudioOutputMode, string][]).map(([value, label]) => {
      const unavailable = outputModeUnavailableReason(value);
      return (
        <option key={value} value={value} disabled={unavailable !== null}>
          {unavailable ? `${label} — ${unavailable}` : label}
        </option>
      );
    })}
  </>
);
