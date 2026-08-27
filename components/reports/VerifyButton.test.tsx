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

describe('VerifyButton menu placement', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  // The grid's scroll container is overflow-x: auto, which clips and scrolls
  // absolutely-positioned descendants. The menu has to escape it entirely.
  function renderInsideScrollContainer() {
    const scroller = document.createElement('div');
    scroller.style.overflowX = 'auto';
    scroller.setAttribute('data-testid', 'scroller');
    document.body.appendChild(scroller);

    render(
      <VerifyButton
        href="mailto:?subject=x"
        label="Verify this finding, web"
        ticket={ticket}
      />,
      { container: scroller }
    );
    return scroller;
  }

  it('renders the menu outside the clipping scroll container', async () => {
    const user = userEvent.setup();
    const scroller = renderInsideScrollContainer();

    await user.click(screen.getByRole('button', { name: /verify/i }));

    const menu = screen.getByRole('menu');
    expect(scroller.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });

  it('positions the menu against the viewport so no ancestor can clip it', async () => {
    const user = userEvent.setup();
    renderInsideScrollContainer();

    await user.click(screen.getByRole('button', { name: /verify/i }));

    expect(screen.getByRole('menu')).toHaveStyle({ position: 'fixed' });
  });

  it('opens upward when the button sits near the bottom of the viewport', async () => {
    const user = userEvent.setup();
    render(<VerifyButton href="mailto:?subject=x" label="Verify this finding, web" ticket={ticket} />);

    const trigger = screen.getByRole('button', { name: /verify/i });
    // Near the bottom edge: a downward menu would run off the page.
    jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: 740, bottom: 764, left: 500, right: 528, width: 28, height: 24, x: 500, y: 740,
      toJSON: () => ({}),
    } as DOMRect);
    window.innerHeight = 768;

    await user.click(trigger);

    const menu = screen.getByRole('menu');
    // Anchored by its bottom to just above the button, rather than below it.
    expect(menu.style.bottom).not.toBe('');
    expect(menu.style.top).toBe('');
  });

  // A fixed menu does not follow its button, so leaving it open while the
  // page scrolls would strand it beside the wrong row.
  it('closes when the page scrolls', async () => {
    const user = userEvent.setup();
    render(<VerifyButton href="mailto:?subject=x" label="Verify this finding, web" ticket={ticket} />);

    await user.click(screen.getByRole('button', { name: /verify/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    window.dispatchEvent(new Event('scroll'));

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  // The menu is no longer a DOM descendant of the button's wrapper, so a
  // naive outside-click check would dismiss it the instant it is used.
  it('stays open when clicking inside the portalled menu', async () => {
    const user = userEvent.setup();
    renderInsideScrollContainer();

    await user.click(screen.getByRole('button', { name: /verify/i }));
    await user.click(screen.getByRole('menu'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
