import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LineItemAssistant from './LineItemAssistant';

function setup() {
  const onFilters = jest.fn();
  render(<LineItemAssistant companyId="company-1" onFilters={onFilters} />);
  return { onFilters };
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

  // An assistant that changes what you are looking at without saying how is a
  // black box. The filter bar shows the fields; this says it in words.
  it('states in words what it applied', async () => {
    reply({ cloudProvider: 'aws', region: 'us-east-1', costMin: 100 });
    setup();

    await userEvent.type(screen.getByLabelText(/^ask$/i), 'aws in us-east-1 over 100');
    await userEvent.click(screen.getByRole('button', { name: /^ask$/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/AWS/);
    expect(status).toHaveTextContent(/us-east-1/);
    expect(status).toHaveTextContent(/at least \$100/);
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
