import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VerifyButton from './VerifyButton';

const ticket = {
  companyId: 'company-1',
  topic: 'Security finding' as const,
  details: 'Security group web (sg-1) allows inbound traffic from the internet on port 22.',
};

function renderButton(overrides: Partial<React.ComponentProps<typeof VerifyButton>> = {}) {
  return render(
    <VerifyButton
      href="mailto:?subject=Verify%20AWS%20security%20finding%3A%20web"
      label="Email to verify this finding, web"
      ticket={ticket}
      {...overrides}
    />
  );
}

describe('VerifyButton', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('shows no menu until the icon is clicked', () => {
    renderButton();

    expect(screen.queryByRole('menuitem', { name: /email/i })).not.toBeInTheDocument();
  });

  it('opens a menu with both actions', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /verify this finding, web/i }));

    expect(screen.getByRole('menuitem', { name: /^email$/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /support ticket/i })).toBeInTheDocument();
  });

  it('keeps Email as a real mailto link so the browser opens the mail client', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /verify/i }));

    expect(screen.getByRole('menuitem', { name: /^email$/i })).toHaveAttribute(
      'href',
      'mailto:?subject=Verify%20AWS%20security%20finding%3A%20web'
    );
  });

  it('posts a support request carrying the company, topic and detail', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ request: { id: 'r1' } }) });
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /verify/i }));
    await user.click(screen.getByRole('menuitem', { name: /support ticket/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('/api/support-requests');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      companyId: 'company-1',
      topics: ['Security finding'],
      details: 'Security group web (sg-1) allows inbound traffic from the internet on port 22.',
      origin: 'portal',
    });
  });

  it('confirms on the row once the ticket is filed', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ request: { id: 'r1' } }) });
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /verify/i }));
    await user.click(screen.getByRole('menuitem', { name: /support ticket/i }));

    expect(await screen.findByText(/ticket sent/i)).toBeInTheDocument();
  });

  // Clicking twice would file two tickets, and the queue has no dedup.
  it('cannot be used again once a ticket is sent', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ request: { id: 'r1' } }) });
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /verify/i }));
    await user.click(screen.getByRole('menuitem', { name: /support ticket/i }));
    await screen.findByText(/ticket sent/i);

    expect(screen.queryByRole('button', { name: /verify/i })).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces the route error rather than a generic failure', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Your account has no email address on file.' }),
    });
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /verify/i }));
    await user.click(screen.getByRole('menuitem', { name: /support ticket/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('no email address on file');
  });

  it('stays usable after a failure so the ticket can be retried', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Nope.' }) });
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /verify/i }));
    await user.click(screen.getByRole('menuitem', { name: /support ticket/i }));
    await screen.findByRole('alert');

    expect(screen.getByRole('button', { name: /verify/i })).toBeEnabled();
  });

  it('closes the menu on Escape', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /verify/i }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menuitem', { name: /^email$/i })).not.toBeInTheDocument();
  });

  it('closes the menu when clicking away', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: /verify/i }));
    await user.click(document.body);

    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: /^email$/i })).not.toBeInTheDocument()
    );
  });
});
