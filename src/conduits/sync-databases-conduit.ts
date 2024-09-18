import {
  DlpDBInfoType,
  DlpOpenConduitReqType,
  DlpReadUserInfoRespType,
} from '../protocols/dlp-commands';
import {DlpConnection} from '../protocols/sync-connections';
import {SyncType} from '../sync-utils/sync-device';
import {ConduitData, ConduitInterface} from './conduit-interface';
import {RawPdbDatabase} from 'palm-pdb';
import {ReadDbOptions, readRawDb} from '../sync-utils/read-db';
import {cleanUpDb, fastSyncDb, slowSyncDb} from '../sync-utils/sync-db';
import debug from 'debug';
import {DatabaseStorageInterface} from '../database-storage/database-storage-interface';

const log = debug('palm-sync').extend('conduit').extend('sync-dbs');

/**
 * This is the main conduit. It synchronises the database that exists on PC with the one
 * that is in the PDA.
 */
export class SyncDatabasesConduit implements ConduitInterface {
  name = 'sync databases';

  async execute(
    dlpConnection: DlpConnection,
    conduitData: ConduitData,
    dbStg: DatabaseStorageInterface
  ): Promise<void> {
    if (conduitData.dbList == null) {
      throw new Error('conduitData.dbList is mandatory for this Conduit');
    }

    await dlpConnection.execute(DlpOpenConduitReqType.with({}));

    switch (conduitData.syncType) {
      case SyncType.FIRST_SYNC:
        log(
          `This is the first sync for this device! Downloading all databases...`
        );

        for (let index = 0; index < conduitData.dbList.length; index++) {
          const dbInfo = conduitData.dbList[index];

          log(
            `Download DB [${index + 1}]/[${conduitData.dbList.length}] - [${dbInfo.name}]`
          );

          const rawDb = await getRawDbFromDevice(dlpConnection, dbInfo);
          if (!rawDb.header.attributes.resDB) {
            await cleanUpDb(rawDb as RawPdbDatabase);
          }

          dbStg.writeDatabase(conduitData.palmID.userName, rawDb);
        }
        break;

      case SyncType.SLOW_SYNC:
      case SyncType.FAST_SYNC:
        for (let index = 0; index < conduitData.dbList.length; index++) {
          const dbInfo = conduitData.dbList[index];

          if (
            await shouldSkipRecord(dbInfo, conduitData.palmID.userName, dbStg)
          ) {
            log(
              `[${index + 1}]/[${conduitData.dbList.length}]: ${
                dbInfo.name
              } skipped.`
            );
            continue;
          }

          const rawDekstopDb = (await dbStg.readDatabase(
            conduitData.palmID.userName,
            `${dbInfo.name}.pdb`
          )) as RawPdbDatabase;

          try {
            if (conduitData.syncType == SyncType.FAST_SYNC) {
              await fastSyncDb(dlpConnection, rawDekstopDb, {cardNo: 0}, false);
            } else {
              await slowSyncDb(dlpConnection, rawDekstopDb, {cardNo: 0}, false);
            }

            log(
              `[${index + 1}]/[${conduitData.dbList.length}]: ${
                dbInfo.name
              }.pdb successfully synced.`
            );

            await dbStg.writeDatabase(
              conduitData.palmID.userName,
              rawDekstopDb
            );
          } catch (error) {
            console.error(
              `Failed to sync resource [${dbInfo.name}], skipping...`,
              error
            );
          }
        }
        break;

      default:
        throw new Error(
          `Invalid sync type! This is an error, please report it to the maintener`
        );
    }
  }
}

async function getRawDbFromDevice(
  dlpConnection: DlpConnection,
  dbInfo: DlpDBInfoType
) {
  const opts: Omit<ReadDbOptions, 'dbInfo'> = {};
  const rawDb = await readRawDb(dlpConnection, dbInfo.name, {
    ...opts,
    dbInfo,
  });

  return rawDb;
}

async function shouldSkipRecord(
  dbInfo: DlpDBInfoType,
  username: string,
  dbStg: DatabaseStorageInterface
): Promise<Boolean> {
  // We only sync databases, so if it's a PRC, we skip
  if (dbInfo.dbFlags.resDB) {
    return true;
  }

  // We only sync databases that has the backup flag set
  if (!dbInfo.dbFlags.backup) {
    return true;
  }

  // We only sync databases that exists on Desktop
  const fileName = `${dbInfo.name}.pdb`;
  const existsInStorage = await dbStg.databaseExists(
    username,
    fileName
  );

  if (!existsInStorage) {
    log(`The databse [${fileName}] does not exists on storage, skipping...`);
    return true;
  }

  return false;
}
