import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FileInput } from '@/components/file-input';
import { Label } from '@/components/ui/label';
import { I18nProvider } from '@/i18n';

// The file field in the admin's own words: the browser's own control (its button and status in the browser's language)
// is never what the user reads. The native input stays the field: labelled, focusable, with its events and its ref.

describe('FileInput', () => {
  it('draws the button in the page language; the native input keeps its label, its attributes and its events', () => {
    const onChange = vi.fn();
    const ref = createRef<HTMLInputElement>();
    render(
      <>
        <Label htmlFor="f">Berkas impor</Label>
        <FileInput ref={ref} id="f" accept=".xml" aria-describedby="f-hint" onChange={onChange} />
      </>,
    );
    expect(screen.getByText('Pilih berkas').getAttribute('aria-hidden')).toBe('true');
    const input = screen.getByLabelText('Berkas impor') as HTMLInputElement;
    expect(input).toBe(ref.current);
    expect(input.type).toBe('file');
    expect(input.accept).toBe('.xml');
    expect(input.getAttribute('aria-describedby')).toBe('f-hint');
    expect(input.tabIndex).toBe(0);
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.xml')] } });
    expect(onChange).toHaveBeenCalledTimes(1);
    // No chosen name was given: nothing is written beside the button.
    expect(screen.queryByText('Belum ada berkas dipilih')).toBeNull();
  });

  it('writes the chosen file, or that none is chosen yet, in the language of the page', () => {
    const { rerender } = render(
      <I18nProvider locale="en">
        <FileInput aria-label="Package" chosen={null} />
      </I18nProvider>,
    );
    expect(screen.getByText('Choose a file')).toBeTruthy();
    expect(screen.getByText('No file chosen yet')).toBeTruthy();
    rerender(
      <I18nProvider locale="en">
        <FileInput aria-label="Package" chosen="altis-1.2.0.zip" />
      </I18nProvider>,
    );
    expect(screen.getByText('altis-1.2.0.zip')).toBeTruthy();
    expect(screen.queryByText('No file chosen yet')).toBeNull();
  });

  it('a disabled field disables the native input', () => {
    render(<FileInput aria-label="Berkas" disabled />);
    expect((screen.getByLabelText('Berkas') as HTMLInputElement).disabled).toBe(true);
  });
});
