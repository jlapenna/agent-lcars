'use client';

import {
  Box,
  Button,
  Card,
  Center,
  Container,
  Group,
  Overlay,
  rem,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconCake, IconCookie, IconTrophy } from '@tabler/icons-react';
import { signIn } from 'next-auth/react';
import * as React from 'react';

interface LoginFormProps {
  e2eTestingUser?: string;
  impersonateAutomaticLogin?: boolean;
}

export default function LoginForm({
  e2eTestingUser,
  impersonateAutomaticLogin,
}: LoginFormProps) {
  const [loading, setLoading] = React.useState(false);

  const handleSlackLogin = async () => {
    setLoading(true);
    try {
      if (impersonateAutomaticLogin || e2eTestingUser) {
        await signIn('credentials', {
          callbackUrl: '/onboarding',
          userId: e2eTestingUser || 'IMPERSONATE',
          name: 'Mock Admin',
          email: 'admin@supersprinkles.racing',
          isAdmin: 'true',
        });
      } else {
        await signIn('slack', { callbackUrl: '/onboarding' });
      }
    } catch (e: unknown) {
      console.error('Login error', e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box
      pos="relative"
      mih="calc(100dvh - var(--app-shell-header-height) - var(--app-shell-footer-height))"
      bg="dark.9"
    >
      <Box
        pos="absolute"
        inset={0}
        style={{
          backgroundImage: 'url(/bg-racing.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          opacity: 0.2,
        }}
      />
      <Overlay
        gradient="radial-gradient(circle at center, transparent 0%, rgba(0,0,0,0.8) 100%)"
        opacity={0.6}
        zIndex={1}
      />

      <Center mih="inherit" pos="relative" style={{ zIndex: 2 }} px="md">
        <Container size="xs">
          <Card
            radius="xl"
            p={rem(40)}
            withBorder
            shadow="xl"
            className="glass vibrant-card"
            maw={rem(400)}
            mx="auto"
          >
            <Stack align="center" gap="xl">
              <Stack align="center" gap="md">
                <Group justify="center" gap="lg">
                  <ThemeIcon
                    size={64}
                    radius="lg"
                    color="sprinkles-lavender"
                    variant="light"
                    style={{ transform: 'rotate(-10deg)' }}
                  >
                    <IconCookie style={{ width: rem(32), height: rem(32) }} />
                  </ThemeIcon>
                  <ThemeIcon
                    size={72}
                    radius="lg"
                    color="sprinkles-blue"
                    variant="light"
                  >
                    <IconCake style={{ width: rem(36), height: rem(36) }} />
                  </ThemeIcon>
                  <ThemeIcon
                    size={64}
                    radius="lg"
                    color="sprinkles-gold"
                    variant="light"
                    style={{ transform: 'rotate(10deg)' }}
                  >
                    <IconTrophy style={{ width: rem(32), height: rem(32) }} />
                  </ThemeIcon>
                </Group>

                <Stack gap={0} align="center">
                  <Title
                    order={1}
                    className="premium-gradient"
                    ta="center"
                    size={rem(40)}
                    fw={900}
                  >
                    Sign in
                  </Title>
                  <Text size="lg" c="dimmed" fw={500} ta="center">
                    to Super Sprinkles
                  </Text>
                </Stack>
              </Stack>

              <Button
                onClick={handleSlackLogin}
                loading={loading}
                size="xl"
                radius="xl"
                fullWidth
                color="sprinkles-blue"
                variant="filled"
                leftSection={
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 122.8 122.8"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.4 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"
                      fill="#e01e5a"
                    />
                    <path
                      d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.4c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"
                      fill="#36c5f0"
                    />
                    <path
                      d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.4 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C77.6 5.8 83.4 0 90.5 0s12.9 5.8 12.9 12.9v32.3z"
                      fill="#2eb67d"
                    />
                    <path
                      d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.4c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z"
                      fill="#ecb22e"
                    />
                  </svg>
                }
                h={rem(64)}
                fz={rem(18)}
                style={{ boxShadow: 'var(--mantine-shadow-lg)' }}
              >
                Sign in with Slack
              </Button>

              <Text size="sm" c="dimmed" ta="center">
                Pastry-adjacent racing access. Mastery in confections.
              </Text>
            </Stack>
          </Card>
        </Container>
      </Center>
    </Box>
  );
}
