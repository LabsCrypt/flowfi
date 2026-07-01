# UI Components Documentation

This document describes the reusable design-system primitives in `frontend/src/components/ui/`.

## Button

A versatile button component with multiple variants, sizes, and loading states.

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `variant` | `'primary' \| 'secondary' \| 'outline' \| 'ghost'` | `'primary'` | Visual style variant |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | Button size |
| `glow` | `boolean` | `false` | Adds a glowing shadow effect |
| `loading` | `boolean` | `false` | Shows spinner and disables button |
| `disabled` | `boolean` | `false` | Disables the button |
| `className` | `string` | `''` | Additional CSS classes |
| `children` | `ReactNode` | - | Button content |

### Variant Descriptions

- **primary**: Accent background with contrasting text (default CTA style)
- **secondary**: Secondary accent background with white text
- **outline**: Transparent with border, subtle hover effect
- **ghost**: Text-only with hover color change

### Loading Behavior

When `loading={true}`:
- Button is automatically disabled
- `aria-busy="true"` is set for accessibility
- A spinning loader icon is prepended to the content
- The "Loading" text is available to screen readers

### Usage Examples

```tsx
import { Button } from '@/components/ui/Button';

// Basic usage
<Button>Click me</Button>

// Primary with glow effect
<Button variant="primary" glow>Connect Wallet</Button>

// Secondary small button
<Button variant="secondary" size="sm">Cancel</Button>

// Loading state
<Button loading>Processing...</Button>

// Outline button
<Button variant="outline">Learn More</Button>

// Ghost button (text-only)
<Button variant="ghost">Skip</Button>
```

---

## Stepper

A step indicator component for multi-step workflows. Uses 1-based indexing for `currentStep`.

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `steps` | `string[]` | - | Array of step labels |
| `currentStep` | `number` | - | Active step (1-based) |
| `className` | `string` | `''` | Additional CSS classes |

### Step States

- **Completed** (`stepNumber < currentStep`): Green checkmark, completed label
- **Active** (`stepNumber === currentStep`): Highlighted circle with step number
- **Upcoming** (`stepNumber > currentStep`): Gray circle with step number

### Usage Examples

```tsx
import { Stepper } from '@/components/ui/Stepper';

// 3-step wizard
<Stepper 
  steps={['Connect Wallet', 'Configure Stream', 'Confirm']} 
  currentStep={1} 
/>

// Second step active
<Stepper 
  steps={['Connect Wallet', 'Configure Stream', 'Confirm']} 
  currentStep={2} 
/>

// All steps completed
<Stepper 
  steps={['Connect Wallet', 'Configure Stream', 'Confirm']} 
  currentStep={4} 
/>
```

---

## Card

A glass-morphism card container with optional hover and glow effects.

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `children` | `ReactNode` | - | Card content |
| `className` | `string` | `''` | Additional CSS classes |
| `glow` | `boolean` | `false` | Adds a glowing shadow effect |
| `hover` | `boolean` | `true` | Enables hover lift effect |

### Usage Examples

```tsx
import { Card } from '@/components/ui/Card';

// Basic card
<Card>
  <h3>Stream Details</h3>
  <p>View your active streams here.</p>
</Card>

// Card with glow effect
<Card glow>
  <h3>Premium Feature</h3>
  <p>This card has a glowing border.</p>
</Card>

// Card without hover effect
<Card hover={false}>
  <h3>Static Card</h3>
  <p>This card doesn't lift on hover.</p>
</Card>

// Card with custom styling
<Card className="col-span-2">
  <h3>Wide Card</h3>
</Card>
```

---

## Skeleton

Loading placeholder components with pulse animation.

### Skeleton (Base)

A simple animated placeholder for loading states.

#### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `className` | `string` | `''` | Additional CSS classes (height, width, etc.) |

#### Usage Examples

```tsx
import { Skeleton } from '@/components/ui/Skeleton';

// Text placeholder
<Skeleton className="h-4 w-32" />

// Avatar placeholder
<Skeleton className="h-12 w-12 rounded-full" />

// Card placeholder
<Skeleton className="h-48 w-full" />
```

### StreamListSkeleton

A pre-built skeleton for stream list loading states.

#### Usage Example

```tsx
import { StreamListSkeleton } from '@/components/ui/Skeleton';

// In a loading state
{isLoading && <StreamListSkeleton />}
```

---

## TransactionTracker

A vertical progress tracker for multi-step transaction flows.

### Types

```typescript
type TransactionStepStatus = 'pending' | 'current' | 'completed' | 'error';

interface TransactionStep {
  id: string;
  label: string;
  description?: string;
  status: TransactionStepStatus;
}
```

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `steps` | `TransactionStep[]` | - | Array of transaction steps |
| `className` | `string` | `''` | Additional CSS classes |

### Step Status Visuals

- **completed**: Green circle with checkmark, accent-colored label
- **current**: Pulsing accent circle with dot, white label
- **error**: Red circle with X, red label
- **pending**: Gray dot, muted label

### Usage Examples

```tsx
import { TransactionTracker, type TransactionStep } from '@/components/ui/TransactionTracker';

const steps: TransactionStep[] = [
  { id: '1', label: 'Connecting Wallet', status: 'completed' },
  { id: '2', label: 'Approving Transaction', status: 'current', description: 'Please confirm in your wallet' },
  { id: '3', label: 'Waiting for Confirmation', status: 'pending' },
  { id: '4', label: 'Stream Created', status: 'pending' },
];

<TransactionTracker steps={steps} />

// With error state
const errorSteps: TransactionStep[] = [
  { id: '1', label: 'Connecting Wallet', status: 'completed' },
  { id: '2', label: 'Approving Transaction', status: 'error', description: 'User rejected the transaction' },
];

<TransactionTracker steps={errorSteps} />
```

---

## Accessibility Notes

- **Button**: Automatically sets `aria-busy="true"` when loading; disabled state prevents interaction
- **Stepper**: Step numbers and labels provide semantic meaning for screen readers
- **TransactionTracker**: Status indicators use both color and icons for non-color-dependent communication
- **All components**: Support `className` prop for custom styling while maintaining base functionality
