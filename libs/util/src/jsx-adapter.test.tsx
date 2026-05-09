/** @jsxImportSource jsx-slack */
import { SectionBlock } from '@slack/types';
import {
  Actions,
  Context,
  Field,
  Fragment,
  Home,
  Mrkdwn,
  Section,
} from 'jsx-slack';

import { toBlocks, toHomeView } from './jsx-adapter';

describe('jsx-adapter', () => {
  describe('toBlocks', () => {
    it('should return an array when passed a single Section', () => {
      const result = toBlocks(<Section>Hello</Section>);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should use mrkdwn type for Section text with formatting', () => {
      const result = toBlocks(
        <Section>
          Hello <b>World</b>
        </Section>,
      );
      const section = result[0] as SectionBlock;
      expect(section.text?.type).toBe('mrkdwn');
    });

    it('should use mrkdwn type for Section text with links', () => {
      const result = toBlocks(
        <Section>
          <a href="https://example.com">Link</a>
        </Section>,
      );
      const section = result[0] as SectionBlock;
      expect(section.text?.type).toBe('mrkdwn');
    });

    it('should NOT escape raw markdown in Section text', () => {
      const result = toBlocks(<Section>*Bold*</Section>);
      const section = result[0] as SectionBlock;
      expect(section.text?.type).toBe('mrkdwn');
      expect(section.text?.text).toBe('*Bold*');
    });

    it('should NOT escape text in Mrkdwn raw component', () => {
      const result = toBlocks(
        <Section>
          <Mrkdwn raw>{'<@U123> is bolded *here*'}</Mrkdwn>
        </Section>,
      );
      const section = result[0] as SectionBlock;
      expect(section.text?.text).toBe('<@U123> is bolded *here*');
    });

    it('should return a flat array for nested Fragments', () => {
      const result = toBlocks(
        <Fragment>
          <Section>A</Section>
          <Fragment>
            <Section>B</Section>
            <Section>C</Section>
          </Fragment>
        </Fragment>,
      );
      expect(result.length).toBe(3);
      expect(result.every((b) => !Array.isArray(b))).toBe(true);
    });

    it('should return a flat blocks array in toHomeView', () => {
      const result = toHomeView(
        <Home>
          <Section>A</Section>
          <Fragment>
            <Section>B</Section>
            <Section>C</Section>
          </Fragment>
        </Home>,
      );
      expect(result.blocks.length).toBe(3);
      expect(result.blocks.every((b) => !Array.isArray(b))).toBe(true);
    });
  });

  describe('validation limits', () => {
    it('should throw if Section has more than 10 fields', () => {
      const fields = Array(11)
        .fill(null)
        .map((_, i) => `Field ${i}`);
      expect(() =>
        toBlocks(
          <Section>
            <b>Title</b>
            {fields.map((f) => (
              <Field>{f}</Field>
            ))}
          </Section>,
        ),
      ).toThrow(/10 fields/);
    });

    it('should throw if Context has more than 10 elements', () => {
      const elements = Array(11)
        .fill(null)
        .map((_, i) => `Element ${i}`);
      expect(() =>
        toBlocks(
          <Context>
            {elements.map((e) => (
              <Mrkdwn>{e}</Mrkdwn>
            ))}
          </Context>,
        ),
      ).toThrow(/10 elements/);
    });

    it('should throw if Actions has more than 25 elements', () => {
      // Create 26 elements
      const elements = Array(26).fill(null);
      expect(() =>
        toBlocks(
          <Actions>
            {elements.map((_, i) => (
              <button actionId={`btn-${i}`}>Btn</button>
            ))}
          </Actions>,
        ),
      ).toThrow(/25 elements/);
    });

    it('should throw if Select has more than 100 options', () => {
      const options = Array(101)
        .fill(null)
        .map((_, i) => `Option ${i}`);
      expect(() =>
        toBlocks(
          <Section>
            Choose:
            <select actionId="select">
              {options.map((o) => (
                <option value={o}>{o}</option>
              ))}
            </select>
          </Section>,
        ),
      ).toThrow(/Maximum allowed is 100/);
    });
  });
});
