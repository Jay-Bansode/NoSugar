import { describe, expect, it } from 'vitest';
import { amountInWords } from './amount-in-words.js';

describe('amountInWords', () => {
  it.each([
    [0, 'Rupees Zero Only'],
    [5, 'Rupees Zero and Five Paise Only'],
    [39900, 'Rupees Three Hundred Ninety-Nine Only'],
    [72250, 'Rupees Seven Hundred Twenty-Two and Fifty Paise Only'],
    [100_000, 'Rupees One Thousand Only'],
    [1_101_101, 'Rupees Eleven Thousand Eleven and One Paise Only'],
    [
      12_345_678,
      'Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six and Seventy-Eight Paise Only',
    ],
    [1_000_000_000, 'Rupees One Crore Only'],
    [
      123_456_789_000,
      'Rupees One Hundred Twenty-Three Crore Forty-Five Lakh Sixty-Seven Thousand Eight Hundred Ninety Only',
    ],
  ])('%i paise → %s', (paise, words) => {
    expect(amountInWords(paise)).toBe(words);
  });

  it('refuses fractions and negatives', () => {
    expect(() => amountInWords(1.5)).toThrow();
    expect(() => amountInWords(-1)).toThrow();
  });
});
