import { Center, Container, Loader, Stack, Text } from '@mantine/core';

export default function Loading() {
  return (
    <Container size="md" py="xl">
      <Center py={100}>
        <Stack align="center" gap="sm">
          <Loader />
          <Text c="dimmed" size="sm">
            Loading agent activity from GitHub…
          </Text>
        </Stack>
      </Center>
    </Container>
  );
}
