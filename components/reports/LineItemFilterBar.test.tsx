import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LineItemFilterBar, { type EditableFilters } from './LineItemFilterBar';

function setup(filters: EditableFilters = {}) {
  const onChange = jest.fn();
  const onClearServiceFilter = jest.fn();
  render(
    <LineItemFilterBar
      filters={filters}
      onChange={onChange}
      serviceFilterCount={0}
      onClearServiceFilter={onClearServiceFilter}
    />
  );
  return { onChange, onClearServiceFilter };
}

describe('LineItemFilterBar', () => {
  it('reports typed search text once it settles', async () => {
    const { onChange } = setup();

    await userEvent.type(screen.getByLabelText(/search/i), 'i-abc123');

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ searchText: 'i-abc123' })));
  });

  // Firing per keystroke would mean eight queries for "i-abc123".
  it('does not fire a change for every keystroke', async () => {
    const { onChange } = setup();

    await userEvent.type(screen.getByLabelText(/search/i), 'abcdefgh');

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.length).toBeLessThan(8);
  });

  it('clears the search filter rather than searching for an empty string', async () => {
    const { onChange } = setup({ searchText: 'ec2' });

    await userEvent.clear(screen.getByLabelText(/search/i));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ searchText: undefined })));
  });

  it('toggles the zero-cost filter', async () => {
    const { onChange } = setup();

    await userEvent.click(screen.getByLabelText(/hide \$0 lines/i));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ excludeZeroCost: true }));
  });

  it('turns the zero-cost filter off again rather than sending false', async () => {
    const { onChange } = setup({ excludeZeroCost: true });

    await userEvent.click(screen.getByLabelText(/hide \$0 lines/i));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ excludeZeroCost: undefined }));
  });

  it('sets the provider filter', async () => {
    const { onChange } = setup();

    await userEvent.selectOptions(screen.getByLabelText(/provider/i), 'aws');

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cloudProvider: 'aws' }));
  });

  // The extra filters are behind a toggle so the common case stays one row.
  it('keeps the secondary filters hidden until asked for', async () => {
    setup();

    expect(screen.queryByLabelText(/billing code/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /more filters/i }));

    expect(screen.getByLabelText(/billing code/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^from$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/cost min/i)).toBeInTheDocument();
  });

  it('sets a billing code filter', async () => {
    const { onChange } = setup();

    await userEvent.click(screen.getByRole('button', { name: /more filters/i }));
    await userEvent.type(screen.getByLabelText(/billing code/i), 'C');

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ billingCode: 'C' }));
  });

  it('reads a cost floor of zero as a real filter, not an empty box', async () => {
    const { onChange } = setup();

    await userEvent.click(screen.getByRole('button', { name: /more filters/i }));
    await userEvent.type(screen.getByLabelText(/cost min/i), '0');

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ costMin: 0 }));
  });

  it('counts the active filters on the toggle, ignoring the search box', async () => {
    setup({ billingCode: 'CC-1', region: 'us-east-1', searchText: 'ignored' });

    expect(await screen.findByRole('button', { name: /more filters \(2\)/i })).toBeInTheDocument();
  });

  it('offers to clear a service filter only when one is set', async () => {
    const onClearServiceFilter = jest.fn();
    const { rerender } = render(
      <LineItemFilterBar
        filters={{}}
        onChange={jest.fn()}
        serviceFilterCount={0}
        onClearServiceFilter={onClearServiceFilter}
      />
    );

    expect(screen.queryByRole('button', { name: /clear service filter/i })).not.toBeInTheDocument();

    rerender(
      <LineItemFilterBar
        filters={{}}
        onChange={jest.fn()}
        serviceFilterCount={3}
        onClearServiceFilter={onClearServiceFilter}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /clear service filter \(3\)/i }));
    expect(onClearServiceFilter).toHaveBeenCalled();
  });
});
