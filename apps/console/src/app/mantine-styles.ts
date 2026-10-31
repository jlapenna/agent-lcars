// Mantine's per-component stylesheets for exactly the components the console
// renders, in @mantine/core/styles.css order. The full sheet is about twice
// the bytes and every route downloads it before hydration (#2201).
// mantine-styles.test.ts derives the required set from the console's imports
// and Mantine's own module graph; add a component there and this list fails
// until its stylesheet is imported here.
import '@mantine/core/styles/baseline.css';
import '@mantine/core/styles/default-css-variables.css';
import '@mantine/core/styles/global.css';
import '@mantine/core/styles/ScrollArea.css';
import '@mantine/core/styles/UnstyledButton.css';
import '@mantine/core/styles/VisuallyHidden.css';
import '@mantine/core/styles/Paper.css';
import '@mantine/core/styles/Overlay.css';
import '@mantine/core/styles/Popover.css';
import '@mantine/core/styles/Loader.css';
import '@mantine/core/styles/ActionIcon.css';
import '@mantine/core/styles/CloseButton.css';
import '@mantine/core/styles/Group.css';
import '@mantine/core/styles/ModalBase.css';
import '@mantine/core/styles/Input.css';
import '@mantine/core/styles/FloatingIndicator.css';
import '@mantine/core/styles/Alert.css';
import '@mantine/core/styles/Text.css';
import '@mantine/core/styles/Anchor.css';
import '@mantine/core/styles/Combobox.css';
import '@mantine/core/styles/InlineInput.css';
import '@mantine/core/styles/CheckboxCard.css';
import '@mantine/core/styles/CheckboxIndicator.css';
import '@mantine/core/styles/Checkbox.css';
import '@mantine/core/styles/Badge.css';
import '@mantine/core/styles/Blockquote.css';
import '@mantine/core/styles/Button.css';
import '@mantine/core/styles/Card.css';
import '@mantine/core/styles/Center.css';
import '@mantine/core/styles/Code.css';
import '@mantine/core/styles/Container.css';
import '@mantine/core/styles/Divider.css';
import '@mantine/core/styles/Image.css';
import '@mantine/core/styles/Menu.css';
import '@mantine/core/styles/Modal.css';
import '@mantine/core/styles/Notification.css';
import '@mantine/core/styles/Progress.css';
import '@mantine/core/styles/Tooltip.css';
import '@mantine/core/styles/SegmentedControl.css';
import '@mantine/core/styles/SimpleGrid.css';
import '@mantine/core/styles/Skeleton.css';
import '@mantine/core/styles/Stack.css';
import '@mantine/core/styles/Switch.css';
import '@mantine/core/styles/Table.css';
import '@mantine/core/styles/Title.css';
