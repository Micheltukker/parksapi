import parksapi from './lib/index.js';
import {entityType, queueType} from './lib/parks/parkTypes.js';
import moment from 'moment-timezone';
import path from 'path';
import {promises as fs} from 'fs';

const __dirname = path.dirname(process.argv[1]);

const destination = new parksapi.destinations.PortAventuraWorld();

destination.on('error', (id, err, data) => {
  console.error(`[✗] ${id}: ${err} ${JSON.stringify(data, null, 4)}`);
  debugger;
});

const _requiredFields = [
  'timezone',
  '_id',
  'name',
  'entityType',
];

const requiredFields = {
  [entityType.destination]: [
    ..._requiredFields,
    'slug',
  ],
  [entityType.park]: [
    ..._requiredFields,
    'slug',
    '_parentId',
    '_destinationId',
  ],
  [entityType.attraction]: [
    ..._requiredFields,
    //'_parkId',
    '_parentId',
    '_destinationId',
    'attractionType',
  ],
  [entityType.show]: [
    ..._requiredFields,
    //'_parkId',
    '_parentId',
    '_destinationId',
  ],
  [entityType.restaurant]: [
    ..._requiredFields,
    //'_parkId',
    '_parentId',
    '_destinationId',
  ],
};

class EntityError extends Error {
  constructor(message, entity) {
    super(message);
    this.name = 'EntityError';
    this.entity = JSON.stringify(entity, null, 4);
  }
}

function TestEntity(ent) {
  if (!ent.entityType) {
    throw new EntityError('entityType is required', ent);
  }
  if (!ent._id) {
    throw new EntityError('_id is required', ent);
  }

  const entityType = ent.entityType;
  if (!requiredFields[entityType]) {
    throw new EntityError(`Invalid entityType: ${entityType}`, ent);
  }

  const fields = requiredFields[entityType];
  for (const field of fields) {
    if (ent[field] === undefined) {
      throw new EntityError(`${field} is required`, ent);
    }
  }
}

function TestLiveData(data, ents) {
  if (!data._id) {
    throw new EntityError('Missing _id', data);
  }
  if (!data.status) {
    throw new EntityError('Missing status', data);
  }

  if (data?.queue && data?.queue[queueType.standBy]) {
    if (typeof data.queue[queueType.standBy].waitTime != 'number' && data.queue[queueType.standBy].waitTime !== null) {
      throw new EntityError('StandbyQueue missing waitTime number', data);
    }
  }

  const ent = ents.find((x) => x._id === data._id);
  if (!ent) {
    console.log(`[✗] Missing entity ${data._id} for livedata: ${JSON.stringify(data)}`);
  }

  // console.log(`[✓] ${data._id}: ${JSON.stringify(data)}`);
}

function TestSchedule(scheduleData, entityId) {
  return;
  const entSchedule = scheduleData.find((x) => x._id === entityId);
  if (!entSchedule) {
    throw new EntityError(`Missing schedule ${entityId}`, scheduleData);
  }

  if (entSchedule.schedule.length === 0) {
    throw new EntityError(`Schedule ${entityId} is empty`, scheduleData);
  }

  for (const schedule of entSchedule.schedule) {
    if (!schedule.type) {
      throw new EntityError('Missing type', schedule);
    }
    if (!schedule.date) {
      throw new EntityError('Missing date', schedule);
    }
    if (!schedule.openingTime) {
      throw new EntityError('Missing openingTime', schedule);
    }
    if (!schedule.closingTime) {
      throw new EntityError('Missing closingTime', schedule);
    }

    const open = moment(schedule.openingTime);
    if (!open.isValid()) {
      throw new EntityError('Invalid openingTime', schedule);
    }

    const close = moment(schedule.closingTime);
    if (!close.isValid()) {
      throw new EntityError('Invalid closingTime', schedule);
    }

  }

  // console.log(entSchedule.schedule);
}

async function TestDestination() {
  TestEntity(await destination.buildDestinationEntity());

  const allEntities = await destination.getAllEntities();
  for (const ent of allEntities) {
    TestEntity(ent);
  }
  console.log(`[✓] ${allEntities.length} entities tested`);
  const entityTypes = allEntities.reduce((x, ent) => {
    x[ent.entityType] = x[ent.entityType] || 0;
    x[ent.entityType]++;
    return x;
  }, {});
  Object.keys(entityTypes).forEach((x) => {
    console.log(`\t${entityTypes[x]} ${x} entities`);
  });
  
  // write all entities to a file
  const entityDataFile = path.join(__dirname, 'testout_Entities.json');
  await fs.writeFile(entityDataFile, JSON.stringify(allEntities, null, 4));

  const schedule = await destination.getEntitySchedules();
  // get parks
  const parks = await destination.getParkEntities();
  for (const park of parks) {
    TestSchedule(schedule, park._id);
  }
  console.log(`[✓] ${parks.length} park schedules tested`);

  const liveData = await destination.getEntityLiveData();
  for (const ent of liveData) {
    TestLiveData(ent, allEntities);
  }
  console.log(`[✓] ${liveData.length} live data tested`);

  // write all live data to file
  const liveDataFile = path.join(__dirname, 'testout_LiveData.json');
  await fs.writeFile(liveDataFile, JSON.stringify(liveData, null, 4));
}

const run = async () => {
  try {
    await TestDestination();
  } catch (err) {
    console.error(err);
  }

  process.exit(0);
};

run();