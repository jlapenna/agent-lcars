import {
  ActionsBlock,
  Block,
  ContextBlock,
  HomeView,
  InputBlock,
  KnownBlock,
  ModalView,
  SectionBlock,
} from '@slack/types';
import {
  Checkboxes,
  MultiStaticSelect,
  Overflow,
  RadioButtons,
  StaticSelect,
} from '@slack/types/dist/block-kit/block-elements';
import { JSXSlack } from 'jsx-slack';
import { JSX } from 'jsx-slack/jsx-runtime';

function validateElement(element: unknown, context: string) {
  if (!element || typeof element !== 'object') return;

  const el = element as Record<string, unknown>;

  if (el.type === 'static_select' || el.type === 'multi_static_select') {
    const select = element as StaticSelect | MultiStaticSelect;
    if (
      (!select.options || select.options.length === 0) &&
      (!select.option_groups || select.option_groups.length === 0)
    ) {
      throw new Error(
        `Slack Block Validation Error: ${el.type} in ${context} must have 'options' or 'option_groups'. Found: ${JSON.stringify(
          element,
        )}`,
      );
    }
    if (select.options && select.options.length > 100) {
      throw new Error(
        `Slack Block Validation Error: ${el.type} in ${context} has ${select.options.length} options. Maximum allowed is 100.`,
      );
    }
    if (select.option_groups && select.option_groups.length > 100) {
      throw new Error(
        `Slack Block Validation Error: ${el.type} in ${context} has ${select.option_groups.length} option_groups. Maximum allowed is 100.`,
      );
    }
  } else if (
    el.type === 'radio_buttons' ||
    el.type === 'checkboxes' ||
    el.type === 'overflow'
  ) {
    const radioOrCheck = element as RadioButtons | Checkboxes | Overflow;
    if (!radioOrCheck.options || radioOrCheck.options.length === 0) {
      throw new Error(
        `Slack Block Validation Error: ${el.type} in ${context} must have 'options'. Found: ${JSON.stringify(
          element,
        )}`,
      );
    }
  }
}

function validateBlocks(blocks: (KnownBlock | Block)[]) {
  blocks.forEach((block, index) => {
    const context = `block index ${index} (${block.type})`;

    if (block.type === 'section') {
      const section = block as SectionBlock;
      if (!section.text && (!section.fields || section.fields.length === 0)) {
        throw new Error(
          `Slack Block Validation Error: Section block at ${context} must have 'text' or 'fields'. Found: ${JSON.stringify(
            block,
          )}`,
        );
      }
      if (section.fields && section.fields.length > 10) {
        throw new Error(
          `Slack Block Validation Error: Section block at ${context} has ${section.fields.length} fields. Maximum allowed is 10.`,
        );
      }
      if (section.accessory) {
        validateElement(section.accessory, `${context} accessory`);
      }
    } else if (block.type === 'actions') {
      const actions = block as ActionsBlock;
      if (!actions.elements || actions.elements.length === 0) {
        throw new Error(
          `Slack Block Validation Error: Actions block at ${context} must have at least one element.`,
        );
      }
      if (actions.elements.length > 25) {
        throw new Error(
          `Slack Block Validation Error: Actions block at ${context} has ${actions.elements.length} elements. Maximum allowed is 25.`,
        );
      }
      actions.elements.forEach((element, elemIdx) => {
        validateElement(element, `${context} element ${elemIdx}`);
      });
    } else if (block.type === 'context') {
      const contextBlock = block as ContextBlock;
      if (!contextBlock.elements || contextBlock.elements.length === 0) {
        throw new Error(
          `Slack Block Validation Error: Context block at ${context} must have at least one element.`,
        );
      }
      if (contextBlock.elements.length > 10) {
        throw new Error(
          `Slack Block Validation Error: Context block at ${context} has ${contextBlock.elements.length} elements. Maximum allowed is 10.`,
        );
      }
    } else if (block.type === 'input') {
      const input = block as InputBlock;
      if (input.element) {
        validateElement(input.element, `${context} element`);
      }
    }
  });
}

/**
 * Converts a JSX element to a Slack Home View.
 */
export function toHomeView(element: JSX.Element): HomeView {
  const view = JSXSlack(element) as HomeView;
  if (view.blocks) {
    view.blocks = (view.blocks as unknown[]).flat(Infinity).filter(Boolean) as (
      | KnownBlock
      | Block
    )[];
    validateBlocks(view.blocks);
  }
  return view;
}

/**
 * Converts a JSX element to a Slack Modal View.
 */
export function toModalView(element: JSX.Element): ModalView {
  const view = JSXSlack(element) as ModalView;
  if (view.blocks) {
    view.blocks = (view.blocks as unknown[]).flat(Infinity).filter(Boolean) as (
      | KnownBlock
      | Block
    )[];
    validateBlocks(view.blocks);
  }
  return view;
}

/**
 * Converts a JSX element to a list of Slack Blocks.
 */
export function toBlocks(element: JSX.Element): (KnownBlock | Block)[] {
  const result = JSXSlack(element);
  const blocks = Array.isArray(result) ? result : [result];
  const flattened = (blocks as unknown[]).flat(Infinity).filter(Boolean) as (
    | KnownBlock
    | Block
  )[];
  validateBlocks(flattened);
  return flattened;
}
