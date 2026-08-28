import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LineItemAssistant from './LineItemAssistant';

function setup() {
  const onFilters = jest.fn();
  const onClear = jest.fn();
  render(<LineItemAssistant companyId="company-1" onFilters={onFilters} onClear={onClear} />);
  return { onFilters, onClear };
}

function reply(filters: unknown, ok = true) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({ ok, json: async () => (ok ? { filters } : filters) });
}

describe('LineItemAssistant', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('sends the question and the company', async () => {
    reply({ searchText: 'ec2' });
    setup();

    await userEvent.type(screen.getByLabelText(/^ask$/i), 'what did we spend on ec2');
    await userEvent.click(screen.getByRole('button', { name: /^ask$/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toEqual({ companyId: 'company-1', question: 'what did we spend on ec2' });
  });

  it('applies the filter it was given', async () => {
    reply({ searchText: 'ec2', costMin: 100 });
    const { onFilters } = setup();

    await userEvent.type(screen.getByLabelText(/^ask$/i), 'ec2 over 100');
    await userEvent.click(screen.getByRole('button', { name: /^ask$/i }));

    await waitFor(() => expect(onFilters).toHaveBeenCalledWith({ searchText: 'ec2', costMin: 100 }));
  });

  // An assistant that changes what you are looking at without showing how is
  // a black box. These are the fields it set, named as the grid names them.
  it('shows the filter it compiled, field by field', async () => {
    reply({ cloudProvider: 'aws', region: 'us-east-1', costMin: 100 });
    setup();

    await userEvent.type(screen.getByLabelText(/^ask$/i), 'aws in us-east-1 over 100');
    await userEvent.click(screen.getByRole('button', { name: /^ask$/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('provider');
    expect(status).toHaveTextContent('aws');
    expect(status).toHaveTextContent('region');
    expect(status).toHaveTextContent('us-east-1');
    expect(status).toHaveTextContent('cost >=');
    expect(status).toHaveTextContent('100');
  });

  // Every filter the parser can return needs a token, or the box would apply
  // something it does not show.
  it('has a token for every filter it can be handed', async () => {
    reply({
      searchText: 'ec2',
      cloudProvider: 'azure',
      serviceNames: ['Amazon EC2'],
      billingCode: 'CC-1',
      accountId: '123',
      region: 'eastus',
      dateFrom: '2026-08-01',
      dateTo: '2026-08-31',
      costMin: 1,
      costMax: 2,
      excludeZeroCost: true,
    });
    setup();

    await userEvent.type(screen.getByLabelText(/^ask$/i), 'everything at once');
    await userEvent.click(screen.getByRole('button', { name: /^ask$/i }));

    const status = await screen.findByRole('status');
    for (const key of ['search', 'provider', 'service', 'billing_code', 'account', 'region', 'from', 'to', 'cost >=', 'cost <=']) {
      expect(status).toHaveTextContent(key);
    }
    expect(status).toHaveTextContent('!= 0');
  });

  it('says so when the question needed no filter at all', async () => {
    reply({});
    setup();

    await userEvent.type(screen.getByLabelText(/^ask$/i), 'show me everything');
    await userEvent.click(screen.getByRole('button', { name: /^ask$/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/showing everything/i);
  });

  it('surfaces the route error rather than a generic one', async () => {
    reply({ error: 'The assistant is not configured. ANTHROPIC_API_KEY is not set.' }, false);
    const { onFilters } = setup();

    await userEvent.type(screen.getByLabelText(/^ask$/i), 'anything');
    await userEvent.click(screen.getByRole('button', { name: /^ask$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not configured/i);
    // A failed question must not silently change what the user is looking at.
    expect(onFilters).not.toHaveBeenCalled();
  });

  it('reports a network failure', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    setup();

    await userEvent.type(screen.getByLabelText(/^ask$/i), 'anything');
    await userEvent.click(screen.getByRole('button', { name: /^ask$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach/i);
  });

  it('will not ask with an empty question', async () => {
    setup();

    expect(screen.getByRole('button', { name: /^ask$/i })).toBeDisabled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  describe('clearing', () => {
    // Nothing to clear yet — an always-present button would be a control that
    // does nothing most of the time.
    it('offers no clear button before anything has been asked', () => {
      setup();

      expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
    });

    it('offers one as soon as there is a question to clear', async () => {
      setup();

      await userEvent.type(screen.getByLabelText(/^ask$/i), 'ec2');

      expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
    });

    it('empties the question and the compiled tokens', async () => {
      reply({ searchText: 'ec2' });
      setup();

      await userEvent.type(screen.getByLabelText(/^ask$/i), 'ec2 costs');
      await userEvent.click(screen.getByRole('button', { name: /^ask$/i }));
      await screen.findByRole('status');

      await userEvent.click(screen.getByRole('button', { name: /clear/i }));

      expect(screen.getByLabelText(/^ask$/i)).toHaveValue('');
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    // Clearing the box has to undo what the box did. Leaving the grid
    // filtered while the question that filtered it disappears is worse than
    // not clearing at all.
    it('tells the tab to drop the filter it applied', async () => {
      reply({ searchText: 'ec2' });
      const { onClear } = setup();

      await userEvent.type(screen.getByLabelText(/^ask$/i), 'ec2 costs');
      await userEvent.click(screen.getByRole('button', { name: /^ask$/i }));
      await screen.findByRole('status');

      await userEvent.click(screen.getByRole('button', { name: /clear/i }));

      expect(onClear).toHaveBeenCalled();
    });

    it('clears an error too', async () => {
      reply({ error: 'The assistant could not answer that.' }, false);
      setup();

      await userEvent.type(screen.getByLabelText(/^ask$/i), 'anything');
      await userEvent.click(screen.getByRole('button', { name: /^ask$/i }));
      await screen.findByRole('alert');

      await userEvent.click(screen.getByRole('button', { name: /clear/i }));

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('clears the previous answer while a new question is running', async () => {
    reply({ searchText: 'first' });
    setup();
    const input = screen.getByLabelText(/^ask$/i);

    await userEvent.type(input, 'first question');
    await userEvent.click(screen.getByRole('button', { name: /^ask$/i }));
    await screen.findByRole('status');

    let release: (value: unknown) => void = () => {};
    (global.fetch as jest.Mock).mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    await userEvent.click(screen.getByRole('button', { name: /^ask$/i }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    release({ ok: true, json: async () => ({ filters: {} }) });
  });
});
