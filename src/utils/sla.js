// ─── SLA CALCULATION UTILITIES ─────────────────────────────────────────────────

// Working hours configuration
export const WORKING_HOURS = {
  sales: { start: 9, end: 22 },      // 9 AM - 10 PM (22:00)
  logistics: { start: 9, end: 20 },  // 9 AM - 8 PM (20:00)
  activation: { start: 9, end: 22 }, // 9 AM - 10 PM (22:00)
};

// Default SLA time configuration (in minutes)
export const DEFAULT_SLA = {
  sales: { workingHours: 120, nonWorkingHours: 120 },
  logistics: { workingHours: 120, nonWorkingHours: 120 },
  activation: { workingHours: 120, nonWorkingHours: 120 },
};

/**
 * Check if a given date is within working hours for a department
 */
export function isWorkingHour(date, department) {
  if (!date) return false;
  const hour = date.getHours();
  const config = WORKING_HOURS[department];
  return hour >= config.start && hour < config.end;
}

/**
 * Calculate working minutes between two dates
 * Only counts time within working hours
 */
export function calculateWorkingMinutes(startDate, endDate, department) {
  if (!startDate || !endDate) return 0;
  if (endDate <= startDate) return 0;

  const config = WORKING_HOURS[department];
  let totalMinutes = 0;
  let current = new Date(startDate);
  const end = new Date(endDate);

  // Maximum iterations to prevent infinite loops (30 days)
  const maxIterations = 30 * 24; // 30 days * 24 hours
  let iterations = 0;

  while (current < end && iterations < maxIterations) {
    iterations++;
    
    const currentHour = current.getHours();
    
    // Create day boundaries
    const dayStart = new Date(current);
    dayStart.setHours(config.start, 0, 0, 0);
    
    const dayEnd = new Date(current);
    dayEnd.setHours(config.end, 0, 0, 0);

    // If we're before working hours, jump to start of working day
    if (currentHour < config.start) {
      current = new Date(dayStart);
      // If start is still before current, move to next day
      if (current <= startDate) {
        current.setDate(current.getDate() + 1);
      }
      continue;
    }

    // If we're after working hours, jump to next working day start
    if (currentHour >= config.end) {
      current = new Date(dayStart);
      current.setDate(current.getDate() + 1);
      continue;
    }

    // We're within working hours, calculate minutes until end of working day or end time
    const segmentEnd = end < dayEnd ? end : dayEnd;
    const minutes = (segmentEnd - current) / (1000 * 60);
    
    if (minutes > 0) {
      totalMinutes += minutes;
    }

    // Move to next day
    current = new Date(dayStart);
    current.setDate(current.getDate() + 1);
  }

  return Math.round(totalMinutes);
}

/**
 * Check SLA status for a single order
 * Returns working minutes used and whether SLA is met
 */
export function checkOrderSLA(order, department, slaConfig) {
  const config = { ...DEFAULT_SLA[department], ...slaConfig };
  
  let startTime;
  let endTime;
  
  switch (department) {
    case 'sales':
      // Sales: from order creation to claim
      startTime = order.orderDT;
      endTime = order.claimDT;
      break;
    case 'logistics':
      // Logistics: from assignment to logistics to logistics claim
      startTime = order.logisticsAssignDT || order.assignDT;
      endTime = order.logisticsClaimDT || order.claimDT;
      break;
    case 'activation':
      // Activation: from logistics assignment to activation assignment
      startTime = order.logisticsAssignDT || order.assignDT;
      endTime = order.activationAssignDT;
      break;
    default:
      return { met: true, workingMinutes: 0, slaMinutes: 0, exceeded: false };
  }

  if (!startTime || !endTime) {
    return { met: true, workingMinutes: 0, slaMinutes: 0, exceeded: false, incomplete: true };
  }

  // Calculate working minutes used
  const workingMinutes = calculateWorkingMinutes(startTime, endTime, department);
  
  // Determine if started in working hours
  const startedInWorkingHours = isWorkingHour(startTime, department);
  
  // Get SLA limit
  const slaMinutes = startedInWorkingHours 
    ? config.workingHours 
    : config.nonWorkingHours;

  // Check if exceeded
  const exceeded = workingMinutes > slaMinutes;

  return {
    met: !exceeded,
    workingMinutes,
    slaMinutes,
    exceeded,
    startedInWorkingHours,
  };
}

/**
 * Calculate average SLA metrics for a list of orders
 */
export function calculateSLAMetrics(orders, department, slaConfig) {
  if (!orders || orders.length === 0) {
    return {
      avgWorkingMinutes: 0,
      slaExceededCount: 0,
      slaMetCount: 0,
      totalCompleted: 0,
      complianceRate: 0,
    };
  }

  let totalWorkingMinutes = 0;
  let slaExceededCount = 0;
  let slaMetCount = 0;
  let totalCompleted = 0;

  orders.forEach(order => {
    const sla = checkOrderSLA(order, department, slaConfig);
    
    if (sla.incomplete) return;
    
    totalCompleted++;
    totalWorkingMinutes += sla.workingMinutes;
    
    if (sla.exceeded) {
      slaExceededCount++;
    } else {
      slaMetCount++;
    }
  });

  return {
    avgWorkingMinutes: totalCompleted > 0 ? Math.round(totalWorkingMinutes / totalCompleted) : 0,
    slaExceededCount,
    slaMetCount,
    totalCompleted,
    complianceRate: totalCompleted > 0 ? Math.round((slaMetCount / totalCompleted) * 100) : 0,
  };
}

/**
 * Format minutes to readable string
 */
export function formatMinutes(minutes) {
  if (!minutes && minutes !== 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

export default {
  WORKING_HOURS,
  DEFAULT_SLA,
  isWorkingHour,
  calculateWorkingMinutes,
  checkOrderSLA,
  calculateSLAMetrics,
  formatMinutes,
};
