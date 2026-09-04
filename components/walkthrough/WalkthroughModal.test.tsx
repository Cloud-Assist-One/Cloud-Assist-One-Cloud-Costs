import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WalkthroughModal from './WalkthroughModal';
import { WALKTHROUGH_STEPS } from '@/lib/walkthroughSteps';

const LAST = WALKTHROUGH_STEPS.length - 1;

async function goToLastStep(user: ReturnType<typeof userEvent.setup>) {
  for (let i = 0; i < LAST; i += 1) {
    await user.click(screen.getByRole('button', { name: 'Next' }));
  }
}

describe('WalkthroughModal', () => {
  it('opens on the first step and shows its screenshot and copy', () => {
    render(<WalkthroughModal onClose={jest.fn()} />);

    expect(screen.getByRole('heading', { name: WALKTHROUGH_STEPS[0].title })).toBeInTheDocument();
    expect(screen.getByText(WALKTHROUGH_STEPS[0].body)).toBeInTheDocument();
    expect(screen.getByText(`Step 1 of ${WALKTHROUGH_STEPS.length}`)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: WALKTHROUGH_STEPS[0].title })).toHaveAttribute(
      'src',
      WALKTHROUGH_STEPS[0].image
    );
  });

  it('cannot go back from the first step', () => {
    render(<WalkthroughModal onClose={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });

  it('advances and retreats through the steps', async () => {
    const user = userEvent.setup();
    render(<WalkthroughModal onClose={jest.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: WALKTHROUGH_STEPS[1].title })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: WALKTHROUGH_STEPS[0].title })).toBeInTheDocument();
  });

  it('swaps Next for Done on the final step and offers the opt-out there', async () => {
    const user = userEvent.setup();
    render(<WalkthroughModal onClose={jest.fn()} />);

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    await goToLastStep(user);

    expect(screen.getByRole('heading', { name: WALKTHROUGH_STEPS[LAST].title })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('finishing without ticking the box does not remember the dismissal', async () => {
    const onClose = jest.fn();
    const user = userEvent.setup();
    render(<WalkthroughModal onClose={onClose} />);

    await goToLastStep(user);
    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('finishing with the box ticked remembers the dismissal', async () => {
    const onClose = jest.fn();
    const user = userEvent.setup();
    render(<WalkthroughModal onClose={onClose} />);

    await goToLastStep(user);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('ticking the box then going back and closing does NOT remember it', async () => {
    const onClose = jest.fn();
    const user = userEvent.setup();
    render(<WalkthroughModal onClose={onClose} />);

    await goToLastStep(user);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Close walkthrough' }));

    // The opt-out is only on offer at the end; leaving early must not silently
    // apply a choice the user backed away from.
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('closes on the X without remembering', async () => {
    const onClose = jest.fn();
    const user = userEvent.setup();
    render(<WalkthroughModal onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Close walkthrough' }));

    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('closes on Escape without remembering', async () => {
    const onClose = jest.fn();
    const user = userEvent.setup();
    render(<WalkthroughModal onClose={onClose} />);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('is a labelled modal dialog', () => {
    render(<WalkthroughModal onClose={jest.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(WALKTHROUGH_STEPS[0].title);
  });
});
