import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DateRangePicker from './DateRangePicker';

describe('DateRangePicker', () => {
  it('calls onGranularityChange when a granularity button is clicked', async () => {
    const onGranularityChange = jest.fn();
    const user = userEvent.setup();
    render(
      <DateRangePicker
        granularity="month"
        onGranularityChange={onGranularityChange}
        rangeLabel="2026-07-01 – 2026-07-31"
        onPrev={jest.fn()}
        onNext={jest.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Week' }));

    expect(onGranularityChange).toHaveBeenCalledWith('week');
  });

  it('calls onPrev and onNext, and displays the range label', async () => {
    const onPrev = jest.fn();
    const onNext = jest.fn();
    const user = userEvent.setup();
    render(
      <DateRangePicker
        granularity="month"
        onGranularityChange={jest.fn()}
        rangeLabel="2026-07-01 – 2026-07-31"
        onPrev={onPrev}
        onNext={onNext}
      />
    );

    expect(screen.getByText('2026-07-01 – 2026-07-31')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /previous/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));

    expect(onPrev).toHaveBeenCalled();
    expect(onNext).toHaveBeenCalled();
  });
});
