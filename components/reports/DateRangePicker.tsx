import type { Granularity } from '@/lib/dateRange';
import styles from './DateRangePicker.module.css';

interface DateRangePickerProps {
  granularity: Granularity;
  onGranularityChange: (granularity: Granularity) => void;
  rangeLabel: string;
  onPrev: () => void;
  onNext: () => void;
}

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

export default function DateRangePicker({
  granularity,
  onGranularityChange,
  rangeLabel,
  onPrev,
  onNext,
}: DateRangePickerProps) {
  return (
    <div className={styles.wrapper}>
      <div className={styles.granularityGroup}>
        {GRANULARITIES.map((g) => (
          <button
            key={g.value}
            type="button"
            aria-pressed={granularity === g.value}
            onClick={() => onGranularityChange(g.value)}
          >
            {g.label}
          </button>
        ))}
      </div>
      <div className={styles.navGroup}>
        <button type="button" aria-label="Previous" onClick={onPrev}>
          ←
        </button>
        <span>{rangeLabel}</span>
        <button type="button" aria-label="Next" onClick={onNext}>
          →
        </button>
      </div>
    </div>
  );
}
