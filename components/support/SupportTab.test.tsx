import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SupportTab from './SupportTab';

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

const existingRequest = {
  id: 'req-1',
  company_id: 'company-1',
  submitted_by: 'user-1',
  first_name: 'Dana',
  email: 'dana@example.com',
  phone: '555-0100',
  phone_ext: '42',
  topics: ['Reduce logging costs'],
  details: null,
  created_at: '2026-08-20T15:00:00.000Z',
};

describe('SupportTab', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('pre-fills the email with the signed-in address but allows changing it', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ requests: [] }));

    render(<SupportTab companyId="company-1" userEmail="signed-in@example.com" />);

    const emailField = await screen.findByLabelText('Email');
    expect(emailField).toHaveValue('signed-in@example.com');

    await userEvent.clear(emailField);
    await userEvent.type(emailField, 'someone-else@example.com');
    expect(emailField).toHaveValue('someone-else@example.com');
  });

  it('shows the contact prompt and every support topic', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ requests: [] }));

    render(<SupportTab companyId="company-1" userEmail="signed-in@example.com" />);

    expect(
      await screen.findByText(
        /need help reducing your cloud billing, tagging resources or cloud technical support\?/i
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/please contact us/i)).toBeInTheDocument();

    for (const topic of [
      'Understanding my cloud billing',
      'Tagging for cost center reporting',
      'S3/Azure bucket cost reduction',
      'Reduce logging costs',
      'EC2/virtual machine cost reduction',
      'Technical cloud support',
      'Other',
    ]) {
      expect(screen.getByRole('checkbox', { name: topic })).toBeInTheDocument();
    }
  });

  it('submits the chosen topics and contact details, then refreshes the grid', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ requests: [] }))
      .mockResolvedValueOnce(jsonResponse({ request: { id: 'req-2' } }))
      .mockResolvedValueOnce(jsonResponse({ requests: [existingRequest] }));

    render(<SupportTab companyId="company-1" userEmail="signed-in@example.com" />);

    await userEvent.type(await screen.findByLabelText('First name'), 'Dana');
    await userEvent.type(screen.getByLabelText('Phone number'), '555-0100');
    await userEvent.type(screen.getByLabelText('Ext.'), '42');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Reduce logging costs' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Technical cloud support' }));
    await userEvent.type(screen.getByLabelText(/details/i), 'Logs are huge');
    await userEvent.click(screen.getByRole('button', { name: /submit request/i }));

    await screen.findByRole('status');

    const submitCall = (global.fetch as jest.Mock).mock.calls[1];
    expect(submitCall[0]).toBe('/api/support-requests');
    expect(JSON.parse(submitCall[1].body)).toEqual({
      companyId: 'company-1',
      firstName: 'Dana',
      email: 'signed-in@example.com',
      phone: '555-0100',
      phoneExt: '42',
      topics: ['Reduce logging costs', 'Technical cloud support'],
      details: 'Logs are huge',
    });

    // The grid reloads so the new ticket appears without a page refresh.
    expect(await screen.findByText('dana@example.com')).toBeInTheDocument();
  });

  it('surfaces the error when submitting fails and keeps what was typed', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ requests: [] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'Please choose at least one topic.' }, false));

    render(<SupportTab companyId="company-1" userEmail="signed-in@example.com" />);

    await userEvent.type(await screen.findByLabelText('First name'), 'Dana');
    await userEvent.click(screen.getByRole('button', { name: /submit request/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Please choose at least one topic.');
    expect(screen.getByLabelText('First name')).toHaveValue('Dana');
  });

  it('lists previously submitted requests', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ requests: [existingRequest] }));

    render(<SupportTab companyId="company-1" userEmail="signed-in@example.com" />);

    expect(await screen.findByText('Dana')).toBeInTheDocument();
    // Scoped to the grid: the topic text also appears as a checkbox label on
    // the form above it.
    const grid = screen.getByRole('table');
    expect(grid).toHaveTextContent('Reduce logging costs');
    // Extension is shown alongside the number rather than as its own column.
    expect(grid).toHaveTextContent('555-0100 ext. 42');
  });

  it('shows an empty state when nothing has been submitted yet', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ requests: [] }));

    render(<SupportTab companyId="company-1" userEmail="signed-in@example.com" />);

    expect(await screen.findByText(/no support requests submitted yet/i)).toBeInTheDocument();
  });

  it('requests only its own company history', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ requests: [] }));

    render(<SupportTab companyId="company-7" userEmail="signed-in@example.com" />);

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/support-requests?companyId=company-7')
    );
  });
});
