import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AwsCredentialsPanel from './AwsCredentialsPanel';
import AzureCredentialsPanel from './AzureCredentialsPanel';
import GcpCredentialsPanel from './GcpCredentialsPanel';
import SnowflakeCredentialsPanel from './SnowflakeCredentialsPanel';

describe('provider credentials panels', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ connections: [] }) });
  });

  it('AWS panel fetches from the AWS endpoint and shows AWS fields', async () => {
    const user = userEvent.setup();
    render(<AwsCredentialsPanel companyId="company-1" />);

    await screen.findByText(/no connections yet/i);
    expect(global.fetch).toHaveBeenCalledWith('/api/settings/aws-credentials?companyId=company-1');
    await user.click(screen.getByRole('button', { name: /add connection/i }));
    expect(screen.getByLabelText(/access key id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/secret access key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^region$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tag to display/i)).toBeInTheDocument();
  });

  it('AWS panel sends the configured tag key when saving a new connection', async () => {
    (global.fetch as jest.Mock).mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return { ok: true, json: async () => ({ connection: { id: 'c1', label: 'Prod', accessKeyIdMasked: '', region: 'us-east-1', tagKey: 'CostCenter' } }) };
      }
      return { ok: true, json: async () => ({ connections: [] }) };
    });

    const user = userEvent.setup();
    render(<AwsCredentialsPanel companyId="company-1" />);

    await screen.findByText(/no connections yet/i);
    await user.click(screen.getByRole('button', { name: /add connection/i }));
    await user.type(screen.getByLabelText(/tag to display/i), 'CostCenter');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    const post = (global.fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(post[1].body)).toMatchObject({ tagKey: 'CostCenter' });
  });

  it('Azure panel fetches from the Azure endpoint and shows Azure fields', async () => {
    const user = userEvent.setup();
    render(<AzureCredentialsPanel companyId="company-1" />);

    await screen.findByText(/no connections yet/i);
    expect(global.fetch).toHaveBeenCalledWith('/api/settings/azure-credentials?companyId=company-1');
    await user.click(screen.getByRole('button', { name: /add connection/i }));
    expect(screen.getByLabelText(/tenant id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^client id$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/client secret/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/subscription id/i)).toBeInTheDocument();
  });

  it('GCP panel fetches from the GCP endpoint and shows GCP fields', async () => {
    const user = userEvent.setup();
    render(<GcpCredentialsPanel companyId="company-1" />);

    await screen.findByText(/no connections yet/i);
    expect(global.fetch).toHaveBeenCalledWith('/api/settings/gcp-credentials?companyId=company-1');
    await user.click(screen.getByRole('button', { name: /add connection/i }));
    expect(screen.getByLabelText(/project id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/service account json key/i)).toBeInTheDocument();
  });

  it('Snowflake panel fetches from the Snowflake endpoint and shows Snowflake fields', async () => {
    const user = userEvent.setup();
    render(<SnowflakeCredentialsPanel companyId="company-1" />);

    await screen.findByText(/no connections yet/i);
    expect(global.fetch).toHaveBeenCalledWith('/api/settings/snowflake-credentials?companyId=company-1');
    await user.click(screen.getByRole('button', { name: /add connection/i }));
    expect(screen.getByLabelText(/account identifier/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^username$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
  });
});
