import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TrialWalkthrough from './TrialWalkthrough';
import { WALKTHROUGH_STEPS } from '@/lib/walkthroughSteps';

const LAST = WALKTHROUGH_STEPS.length - 1;

async function finishTour(user: ReturnType<typeof userEvent.setup>, { tickBox }: { tickBox: boolean }) {
  for (let i = 0; i < LAST; i += 1) {
    await user.click(screen.getByRole('button', { name: 'Next' }));
  }
  if (tickBox) await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Done' }));
}

beforeEach(() => {
  sessionStorage.clear();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ dismissed: true }) });
});

describe('TrialWalkthrough', () => {
  it('opens on the first load of a browser session', async () => {
    render(<TrialWalkthrough />);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('does not reopen on a later load in the same session', () => {
    const first = render(<TrialWalkthrough />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    first.unmount();

    // A refresh, or navigating back to the dashboard, remounts the component
    // with sessionStorage intact -- it must stay shut.
    render(<TrialWalkthrough />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens again in a fresh session', () => {
    const first = render(<TrialWalkthrough />);
    first.unmount();
    sessionStorage.clear(); // what signing out and back in amounts to here

    render(<TrialWalkthrough />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('saves the opt-out only when the box was ticked', async () => {
    const user = userEvent.setup();
    render(<TrialWalkthrough />);

    await finishTour(user, { tickBox: true });

    expect(global.fetch).toHaveBeenCalledWith('/api/walkthrough/dismiss', { method: 'POST' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('finishing without ticking the box saves nothing', async () => {
    const user = userEvent.setup();
    render(<TrialWalkthrough />);

    await finishTour(user, { tickBox: false });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('still closes when saving the preference fails', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    render(<TrialWalkthrough />);

    await finishTour(user, { tickBox: true });

    // The tour is over either way; a failed write just means it returns next
    // session, which is self-correcting and better than trapping the user.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
