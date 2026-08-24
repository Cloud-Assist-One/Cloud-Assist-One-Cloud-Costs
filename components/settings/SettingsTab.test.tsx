import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsTab from './SettingsTab';

jest.mock('./AwsCredentialsPanel', () => ({
  __esModule: true,
  default: () => <div>aws-credentials-panel</div>,
}));
jest.mock('./AzureCredentialsPanel', () => ({
  __esModule: true,
  default: () => <div>azure-credentials-panel</div>,
}));
jest.mock('./GcpCredentialsPanel', () => ({
  __esModule: true,
  default: () => <div>gcp-credentials-panel</div>,
}));
jest.mock('./SnowflakeCredentialsPanel', () => ({
  __esModule: true,
  default: () => <div>snowflake-credentials-panel</div>,
}));

describe('SettingsTab', () => {
  it('defaults to the AWS panel', async () => {
    render(<SettingsTab companyId="company-1" />);

    expect(await screen.findByText('aws-credentials-panel')).toBeInTheDocument();
  });

  it('switches to the Azure panel', async () => {
    const user = userEvent.setup();
    render(<SettingsTab companyId="company-1" />);

    await screen.findByText('aws-credentials-panel');
    await user.click(screen.getByRole('tab', { name: /microsoft azure/i }));
    expect(await screen.findByText('azure-credentials-panel')).toBeInTheDocument();
    expect(screen.queryByText('aws-credentials-panel')).not.toBeInTheDocument();
  });

  it('switches to the GCP panel', async () => {
    const user = userEvent.setup();
    render(<SettingsTab companyId="company-1" />);

    await screen.findByText('aws-credentials-panel');
    await user.click(screen.getByRole('tab', { name: /google cloud/i }));
    expect(await screen.findByText('gcp-credentials-panel')).toBeInTheDocument();
  });

  it('switches to the Snowflake panel', async () => {
    const user = userEvent.setup();
    render(<SettingsTab companyId="company-1" />);

    await screen.findByText('aws-credentials-panel');
    await user.click(screen.getByRole('tab', { name: /snowflake/i }));
    expect(await screen.findByText('snowflake-credentials-panel')).toBeInTheDocument();
  });
});
