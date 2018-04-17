'use strict';

import * as yamljs from 'yamljs';
import * as clipboardy from 'clipboardy';
import { QuickPickOptions } from 'vscode';

import { host } from '../../host';
import { ServiceType } from './binding';
import { fs } from '../../fs';
import { pickChart } from '../../helm.exec';

interface ChartYaml {
    path: string;
    yaml: any;
}

/**
 * Writes the secret keys (not the values) to the values.yaml.
 * @param serviceType the type of the service
 * @param bindingName the name of the binding/service
 * @param secretKeys array containing keys in the deployed secret.
 * @param chartYaml ChartYaml object.
 */
export async function writeSecretData (
    serviceType: ServiceType,
    bindingName: string,
    value: string | string[],
    chartYaml: ChartYaml
) {
    switch (serviceType) {
        case ServiceType.serviceEnv:
            const serviceBinding = {
                name: bindingName,
                value: value
            };

            if (chartYaml.yaml.serviceEnv) {
                chartYaml.yaml.serviceEnv.push(serviceBinding);
            } else {
                chartYaml.yaml.serviceEnv = [serviceBinding];
            }
            break;
        case ServiceType.serviceCatalogEnv:
            // if we have service catalog keys already, add them.
            const serviceCatalogBinding = {
                name: bindingName,
                vars: value
            };

            if (chartYaml.yaml.serviceCatalogEnv) {
                chartYaml.yaml.serviceCatalogEnv.push(serviceCatalogBinding);
            } else {
                chartYaml.yaml.serviceCatalogEnv = [serviceCatalogBinding];
            }
            break;
        default:
            break;
    }

    // remove the file, and re-write our modified version.
    await fs.unlinkAsync(chartYaml.path);
    await fs.writeFile(chartYaml.path, yamljs.stringify(chartYaml.yaml, 2));
}

/**
 * Checks to see if we've already added a binding for a service.
 * @param serviceType
 * @param bindingName A binding name to check in valuesYaml.serviceCatalogEnv.
 * @param valuesYaml The loaded values.yaml file.
 * @returns A boolean indicating that the binding to be added is already in the values yaml.
 */
export function isBindingAdded (serviceType: ServiceType, bindingName: string, valuesYaml): boolean {
    const environment = valuesYaml[serviceType];

    if (!environment) {
        return false;
    }

    return environment.some((binding) => {
        return binding.name === bindingName;
    });
}

export async function pickChartAsync (): Promise<any> {
    return new Promise((resolve, reject) => {
        pickChart((chartPath) => {
            resolve(chartPath);
        });
    });
}

/**
 * Writes usage information for the deployed service to the system clipboard.
 * @param serviceType the type of Service to write binding info for.
 * @param bindingName The name of the external service
 * @param secretKeys The keys to write usage information about.
 */
export async function writeUsageToClipboard (
    serviceType: ServiceType,
    bindingName: string,
    secretKeys: string | string[]
) {
    if (serviceType === ServiceType.serviceEnv) {
        const message = `// To use service ${bindingName}, we added an environment variable containing the DNS hostname: SERVICE_${bindingName.toUpperCase()}`;
        await clipboardy.write(message);
        return;
    }

    host.showInformationMessage("Wrote Service Usage information to your clipboard.");

    const environmentVariableMessages: string[] = [];

    for (const variableName of secretKeys) {
        const envVar = `${bindingName}_${variableName}`.toUpperCase();
        environmentVariableMessages.push(
            `// ${envVar}`
        );
    }

    const message = `// To use service ${bindingName}, we added a number of environment variables\n// to your application, as listed below:\n${environmentVariableMessages.join('\n')}`;

    await clipboardy.write(message);
}

export async function loadChartValues (): Promise<ChartYaml> {
    const chartPath = await pickChartAsync();
    const valuesFile = `${chartPath}/values.yaml`;
    const valuesYaml = yamljs.load(valuesFile);

    return {
        path: valuesFile,
        yaml: valuesYaml
    } as ChartYaml;
}

export async function removeServiceBinding (serviceType: ServiceType) {
    const chartYaml = await loadChartValues();

    if (chartYaml.yaml[serviceType].length === 0) {
        host.showInformationMessage("No Services to remove.");
        return;
    }

    const chartBindings = [];
    for (let binding of chartYaml.yaml[serviceType]) {
        chartBindings.push(binding.name);
    }

    const bindingToRemove = await host.showQuickPick(chartBindings, {
        placeholder: "Select a Service to remove"
    } as QuickPickOptions);

    // No selection was made.
    if (bindingToRemove === undefined || bindingToRemove === "") {
        return;
    }

    const prunedChartBindings = chartYaml.yaml[serviceType].filter((binding) =>
        binding.name != bindingToRemove
    );

    chartYaml.yaml[serviceType] = prunedChartBindings;

    await fs.unlinkAsync(chartYaml.path);
    await fs.writeFile(chartYaml.path, yamljs.stringify(chartYaml.yaml, 2));
}