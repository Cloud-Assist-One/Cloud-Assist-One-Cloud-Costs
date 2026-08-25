import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SupportRequestsTab from './SupportRequestsTab';

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

const request = {
  id: 'req-1',
  company_id: 'company-1',
  company_name: 'Initech',
  submitted_by: 'user-1',
  first_name: 'Dana',
  email: 'dana@example.com',
  phone: null,
  phone_ext: null,
  topics: ['Understanding my cloud billing', 'Other'],
  details: 'Bill jumped last month',
  created_at: '2026-08-20T15:00:00.000Z',
};

describe('SupportRequestsTab', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('loads every company’s requests and shows which company each came from', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ requests: [request] }));

    render(<SupportRequestsTab />);

    expect(await screen.findByText('Initech')).toBeInTheDocument();
    expect(screen.getByText('Dana')).toBeInTheDocument();
    expect(screen.getByText('Understanding my cloud billing, Other')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/api/support-requests?scope=all');
  });

  it('shows a dash where no phone number was given', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ requests: [request] }));

    render(<SupportRequestsTab />);

    await screen.findByText('Initech');
    expect(screen.getByRole('table')).toHaveTextContent('—');
  });

  it('surfaces an authorization failure rather than showing an empty queue', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ error: 'Admin access required.' }, false));

    render(<SupportRequestsTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Admin access required.');
  });

  it('refetches when Refresh is clicked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ requests: [] }))
      .mockResolvedValueOnce(jsonResponse({ requests: [request] }));

    render(<SupportRequestsTab />);

    await screen.findByText(/no support requests have been submitted yet/i);
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));

    expect(await screen.findByText('Initech')).toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
  });
});
